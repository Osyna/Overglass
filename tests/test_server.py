"""Offline tests for webos_foundry.server: route table, auth, Host/Origin refusal, jobs, stream.

Every request goes to a real ThreadingHTTPServer on 127.0.0.1 (or the 0.0.0.0 wildcard, reached via loopback) with
the TV-facing functions monkeypatched; nothing here ever opens a connection to a TV.
"""
import http.client
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

import pytest

try:
    from webos_foundry import capture, notify, process, server, tv
    from webos_foundry.config import Config
    from webos_foundry.errors import Cancelled, TransportError, TvBusyError, ValidationError
except ImportError as error:  # a sibling module is not written yet; the parent re-runs the full suite later
    pytest.skip("webos_foundry core modules unavailable: %s" % error, allow_module_level=True)

TOKEN = "t0ken-" + "x" * 30
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 16


# ---- helpers

class Served:
    def __init__(self, bind="127.0.0.1", token=None, transport=object()):
        self.server = server.FoundryServer((bind, 0), token=token, transport=transport)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        finally:
            conn.close()

    def json(self, method, path, body=None, headers=None):
        send = dict(headers or {})
        if body is not None:
            send.setdefault("Content-Type", "application/json")
            body = json.dumps(body)
        status, head, data = self.request(method, path, body, send)
        return status, json.loads(data)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def serve(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path / "home"))  # no saved config unless a test writes one
    started = []

    def make(**kwargs):
        started.append(Served(**kwargs))
        return started[-1]

    yield make
    for item in started:
        item.close()
    server.JOBS.clear()
    if server.ROOT is not None:
        shutil.rmtree(server.ROOT, ignore_errors=True)
        server.ROOT = None


def bearer(token=TOKEN):
    return {"Authorization": "Bearer " + token}


# ---- route table

def test_routes_are_self_consistent():
    keys = [(r["method"], r["path"]) for r in server.ROUTES]
    assert len(keys) == len(set(keys))
    for r in server.ROUTES:
        assert r["group"] and r["summary"] and callable(r["handler"])
        assert all(r.get(k) is not None for k in ("returns", "tv", "example")), r["path"]
        params = set(re.findall(r"\{(\w+)\}", r["path"]))
        assert params == set(r["regex"].groupindex), r["path"]
        # the documented example must resolve to this very route
        example = r["example"]["path"].split("?")[0]
        matches = [o for o in server.ROUTES if o["method"] == r["method"] and o["regex"].match(example)]
        assert matches == [r], (r["path"], example)


def test_route_matching_and_unmatched_paths():
    found = {("GET", "/api/jobs/abc"): {"id": "abc"}, ("POST", "/api/jobs/abc/cancel"): {"id": "abc"},
             ("PUT", "/api/settings/sound/aiSound"): {"category": "sound", "key": "aiSound"},
             ("POST", "/api/remote/hdmi"): {"action": "hdmi"}, ("GET", "/api/health"): {}}
    for (method, path), expected in found.items():
        hits = [r for r in server.ROUTES if r["method"] == method and r["regex"].match(path)]
        assert len(hits) == 1 and hits[0]["regex"].match(path).groupdict() == expected, path
    assert not any(r["regex"].match("/api/jobs/a/b/c") for r in server.ROUTES)
    assert {r["path"] for r in server.ROUTES} >= {"/api", "/api/health", "/api/status", "/api/details",
                                                 "/api/notify/toast", "/api/notify/say", "/api/overlay",
                                                 "/api/screenshot", "/api/screen/stream", "/api/remote/{action}",
                                                 "/api/settings", "/api/settings/{category}/{key}", "/api/jobs",
                                                 "/api/jobs/{id}", "/api/jobs/{id}/cancel", "/api/jobs/{id}/release",
                                                 "/api/jobs/{id}/result"}


def test_documented_values_match_the_core_modules():
    assert set(server.REMOTE) == set(tv.REMOTE_ACTIONS)
    assert set(process.IMAGE_PROFILES + process.AUDIO_PROFILES) <= set(server.PROFILE_LABELS)
    remote_route = next(r for r in server.ROUTES if r["path"] == "/api/remote/{action}")
    assert [v["name"] for v in remote_route["values"]] == list(server.REMOTE)


def test_pure_helpers():
    assert server.sniff(b"\x89PNG\r\n\x1a\n\0") == ("image", ".png")
    assert server.sniff(b"\xff\xd8\xff\xe0") == ("image", ".jpg")
    assert server.sniff(b"RIFF\0\0\0\0WAVEfmt ") == ("audio", ".wav")
    for data in (b"", b"GIF89a", b"RIFF\0\0\0\0AVI ", b"<svg>"):
        with pytest.raises(server.ApiError) as raised:
            server.sniff(data)
        assert raised.value.status == 415
    assert server.safe_stem("../../etc/pass wd.png") == "pass-wd" and server.safe_stem("...") == "upload"
    assert server.screenshot_args({}) == (1920, 1080, "jpg")
    assert server.screenshot_args({"width": "960", "format": "png"}) == (960, 540, "png")
    with pytest.raises(ValueError):
        server.screenshot_args({"width": "wide"})
    assert server.stream_args({}) == (160, 90, 30) and server.stream_args({"width": "320", "fps": "60"}) == (320, 180, 60)
    for bad in ({"width": "161"}, {"width": "160", "height": "180"}, {"fps": "9"}, {"fps": "61"}, {"fps": "x"}):
        with pytest.raises(ValueError):
            server.stream_args(bad)


# ---- Host / Origin refusal (DNS rebinding, cross-site writes) and auth, as pure functions

def test_allowed_hosts():
    assert server.allowed_hosts("127.0.0.1", 8765) == {"127.0.0.1:8765", "localhost:8765", "[::1]:8765"}
    assert server.allowed_hosts("192.168.1.5", 8765) == {"192.168.1.5:8765"}
    assert server.allowed_hosts("::1", 8765) == {"[::1]:8765", "127.0.0.1:8765", "localhost:8765"}
    assert server.allowed_hosts("0.0.0.0", 8765) is None and server.allowed_hosts("::", 8765) is None


def test_caller_error():
    loop = server.allowed_hosts("127.0.0.1", 8765)
    assert server.caller_error("GET", "127.0.0.1:8765", None, None, loop) is None
    assert server.caller_error("POST", "localhost:8765", "http://localhost:8765", "same-origin", loop) is None
    assert server.caller_error("POST", "127.0.0.1:8765", None, None, loop) is None  # curl
    assert server.caller_error("GET", "evil.example:8765", None, None, loop)[0] == 421  # DNS rebinding
    assert server.caller_error("GET", "127.0.0.1:9999", None, None, loop)[0] == 421
    assert server.caller_error("POST", "127.0.0.1:8765", "https://evil.example", "cross-site", loop)[0] == 403
    assert server.caller_error("PUT", "127.0.0.1:8765", None, "cross-site", loop)[0] == 403
    lan = server.allowed_hosts("192.168.1.5", 8765)  # generalised to the bind host, not hardcoded loopback
    assert server.caller_error("GET", "192.168.1.5:8765", None, None, lan) is None
    assert server.caller_error("GET", "127.0.0.1:8765", None, None, lan)[0] == 421
    # wildcard bind: any Host, but a write must still be same-origin
    assert server.caller_error("POST", "10.0.0.2:8765", "http://10.0.0.2:8765", None, None) is None
    assert server.caller_error("POST", "10.0.0.2:8765", "http://evil.example", None, None)[0] == 403


def test_auth_error():
    check = server.auth_error
    assert check("/api/status", None, TOKEN, loopback=True) is None  # optional on loopback
    assert check("/api/status", None, None, loopback=True) is None
    assert check("/api/status", "Bearer " + TOKEN, TOKEN, loopback=True) is None
    assert check("/api/status", "Bearer wrong", TOKEN, loopback=True)[0] == 401
    assert check("/api/status", None, TOKEN, loopback=False)[0] == 401  # required elsewhere
    assert check("/api/status", "Bearer wrong", TOKEN, loopback=False)[0] == 401
    assert check("/api/status", "Basic " + TOKEN, TOKEN, loopback=False)[0] == 401
    assert check("/api/status", "Bearer " + TOKEN, TOKEN, loopback=False) is None
    assert check("/api/status", "bearer " + TOKEN, TOKEN, loopback=False) is None
    assert check("/api/status", "Bearer anything", None, loopback=False)[0] == 401  # no token configured: fail closed
    for public in ("/api", "/api/health", "/", "/app.js", "/app.css"):
        assert check(public, None, TOKEN, loopback=False) is None


# ---- over HTTP

def test_loopback_without_token_is_open(serve, monkeypatch):
    monkeypatch.setattr(server.tv, "get_status", lambda transport: {"power": "on"})
    assert serve().json("GET", "/api/status") == (200, {"power": "on"})


def test_loopback_with_token_is_optional_but_must_be_right(serve, monkeypatch):
    monkeypatch.setattr(server.tv, "get_status", lambda transport: {"power": "on"})
    app = serve(token=TOKEN)
    assert app.json("GET", "/api/status") == (200, {"power": "on"})
    assert app.json("GET", "/api/status", headers=bearer()) == (200, {"power": "on"})
    status, body = app.json("GET", "/api/status", headers=bearer("wrong"))
    assert status == 401 and "error" in body


def test_non_loopback_requires_the_token(serve, monkeypatch):
    monkeypatch.setattr(server.tv, "get_status", lambda transport: {"power": "on"})
    app = serve(bind="0.0.0.0", token=TOKEN)
    status, head, data = app.request("GET", "/api/status")
    assert status == 401 and head["www-authenticate"] == "Bearer" and "error" in json.loads(data)
    assert app.json("GET", "/api/status", headers=bearer("wrong"))[0] == 401
    assert app.json("GET", "/api/status", headers=bearer()) == (200, {"power": "on"})
    assert app.json("GET", "/api/nope")[0] == 401  # unknown paths do not reveal routes without a token
    assert app.json("GET", "/api")[0] == 200 and app.json("GET", "/api/health")[0] == 200
    status, head, data = app.request("GET", "/")
    assert status == 200 and b"webOS Foundry" in data and "script-src 'self'" in head["content-security-policy"]
    assert app.json("POST", "/api/notify/toast", {"message": "x"})[0] == 401


def test_non_loopback_without_any_token_refuses_everything(serve):
    assert serve(bind="0.0.0.0").json("GET", "/api/status", headers=bearer("whatever"))[0] == 401


def test_catalogue_is_json_and_hides_internals(serve):
    status, body = serve().json("GET", "/api")
    assert status == 200 and {"tv", "errors", "kinds", "routes", "base"} <= set(body)
    assert all(not ({"handler", "regex"} & set(route)) for route in body["routes"])
    expected = {"method", "path", "group", "summary", "returns", "tv", "example"}
    assert all(expected <= set(route) for route in body["routes"])
    assert body["kinds"]["image"]["profiles"][0]["id"] == process.IMAGE_PROFILES[0]
    assert "mac" not in json.dumps(body["tv"]).lower()


def test_health_unpaired(serve, monkeypatch):
    app = serve(transport=None)
    assert app.json("GET", "/api/health") == (200, {"paired": False, "tv_host": None})
    # a config that has a token but no TV yet is still unpaired
    Config.for_dir(Path(os.environ["WEBOS_FOUNDRY_HOME"]), server_token=TOKEN).save()
    assert app.json("GET", "/api/health") == (200, {"paired": False, "tv_host": None})


def test_health_malformed_config_is_unpaired(serve, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.json").write_text("{not json")
    assert serve(transport=None).json("GET", "/api/health") == (200, {"paired": False, "tv_host": None})


def test_health_paired_needs_no_token(serve):
    Config.for_dir(Path(os.environ["WEBOS_FOUNDRY_HOME"]), tv_host="192.168.1.50").save()
    app = serve(bind="0.0.0.0", token=TOKEN, transport=None)
    assert app.json("GET", "/api/health") == (200, {"paired": True, "tv_host": "192.168.1.50"})


def test_unpaired_api_routes_answer_503(serve):
    app = serve(transport=None)
    for method, path in (("GET", "/api/status"), ("GET", "/api/jobs"), ("POST", "/api/notify/toast")):
        status, body = app.json(method, path, {"message": "x"} if method == "POST" else None)
        assert (status, body) == (503, {"error": "Not paired; run: wof pair --host <ip>"}), path
    assert app.json("GET", "/api")[0] == 200 and app.json("GET", "/api/health")[0] == 200


def test_host_header_and_cross_site_refusal(serve, monkeypatch):
    monkeypatch.setattr(server.notify, "toast", lambda transport, text: "Toast shown on the TV")
    app = serve()
    port = app.port
    assert app.json("GET", "/api", headers={"Host": "evil.example:%d" % port})[0] == 421
    assert app.json("GET", "/api", headers={"Host": "localhost:%d" % port})[0] == 200
    post = {"message": "hi"}
    assert app.json("POST", "/api/notify/toast", post, {"Origin": "https://evil.example"})[0] == 403
    assert app.json("POST", "/api/notify/toast", post, {"Sec-Fetch-Site": "cross-site"})[0] == 403
    assert app.json("POST", "/api/notify/toast", post, {"Origin": "http://127.0.0.1:%d" % port})[0] == 200
    assert app.json("POST", "/api/notify/toast", post) == (200, {"message": "Toast shown on the TV"})  # curl


def test_bad_requests_and_error_mapping(serve, monkeypatch):
    app = serve()
    assert app.json("GET", "/api/nope")[0] == 404
    assert app.json("DELETE", "/api/status")[0] == 405
    status, body = app.json("PUT", "/api/status")
    assert status == 405 and "GET" in body["error"]
    assert app.request("POST", "/api/notify/toast", "{}", {"Content-Type": "text/plain"})[0] == 415
    assert app.request("POST", "/api/notify/toast", "[1]", {"Content-Type": "application/json"})[0] == 400
    assert app.request("POST", "/api/notify/toast", "{bad", {"Content-Type": "application/json"})[0] == 400
    for error, expected in ((TvBusyError("TV busy"), 409), (ValidationError("bad"), 400),
                            (TransportError("no route"), 502), (RuntimeError("boom"), 502)):
        monkeypatch.setattr(server.tv, "get_status", lambda transport, error=error: (_ for _ in ()).throw(error))
        status, body = app.json("GET", "/api/status")
        assert status == expected and body["error"], error
    monkeypatch.setattr(server.tv, "get_status", lambda transport: (_ for _ in ()).throw(KeyError("x")))
    assert app.json("GET", "/api/status")[0] == 500


def test_handlers_pass_the_transport_and_arguments(serve, monkeypatch):
    marker, seen = object(), []
    monkeypatch.setattr(server.tv, "remote", lambda t, action, value=None: seen.append((t, action, value)) or "ok")
    monkeypatch.setattr(server.tv, "set_setting", lambda t, c, k, v, ctx: seen.append((t, c, k, v, ctx)) or "set")
    monkeypatch.setattr(server.notify, "say", lambda t, text, volume=15: seen.append((t, text, volume)) or "said")
    monkeypatch.setattr(server.notify, "overlay_hide", lambda t: seen.append((t, "hide")) or "hidden")
    monkeypatch.setattr(server.notify, "overlay_show", lambda t, card: seen.append((t, card)) or "shown")
    app = serve(transport=marker)
    assert app.json("POST", "/api/remote/hdmi", {"value": 2}) == (200, {"action": "hdmi", "message": "ok"})
    assert app.json("POST", "/api/remote/home") == (200, {"action": "home", "message": "ok"})
    assert app.json("POST", "/api/remote/bogus")[0] == 404
    assert app.json("PUT", "/api/settings/sound/aiSound", {"value": "on", "context": {}}) == (200, {"message": "set"})
    assert app.json("POST", "/api/notify/say", {"message": "hi", "volume": 9}) == (200, {"message": "said"})
    assert app.json("POST", "/api/overlay", {"hide": True}) == (200, {"message": "hidden"})
    assert app.json("POST", "/api/overlay", {"title": "t"}) == (200, {"message": "shown"})
    assert seen == [(marker, "hdmi", 2), (marker, "home", None), (marker, "sound", "aiSound", "on", {}),
                    (marker, "hi", 9), (marker, "hide"), (marker, {"title": "t"})]


def test_screenshot_route(serve, monkeypatch):
    calls = []
    monkeypatch.setattr(server.capture, "screenshot", lambda t, w, h, f: calls.append((w, h, f)) or (b"\xff\xd8\xffJPEG", "image/jpeg"))
    status, head, data = serve().request("GET", "/api/screenshot?width=960")
    assert (status, head["content-type"], data, calls) == (200, "image/jpeg", b"\xff\xd8\xffJPEG", [(960, 540, "jpg")])


def test_live_stream_frames(serve, monkeypatch):
    frame = bytes(160 * 90 * 3)
    monkeypatch.setattr(server.capture, "stream", lambda t, w, h, f: iter([(w, h, frame), (w, h, frame)]))
    status, head, data = serve().request("GET", "/api/screen/stream")
    assert status == 200 and head["content-type"] == "application/octet-stream"
    assert data[:4] == b"WOF1" and data[4:8] == bytes([160, 0, 90, 0]) and len(data) == 8 + 2 * len(frame)


def test_live_stream_start_failure_is_a_json_error(serve, monkeypatch):
    monkeypatch.setattr(server.capture, "stream", lambda *a: iter(()))
    status, body = serve().json("GET", "/api/screen/stream")
    assert status == 502 and "first frame" in body["error"]
    assert not server.STREAM_LOCK.locked()


# ---- processing jobs

def wait_for(app, job_id, states, seconds=10):
    deadline = time.time() + seconds
    while time.time() < deadline:
        status, job = app.json("GET", "/api/jobs/" + job_id)
        if job["state"] in states:
            return job
        time.sleep(0.02)
    raise AssertionError("job stuck in %s" % job["state"])


def test_job_lifecycle_done(serve, monkeypatch):
    def enhance(transport, source, output, profile, *, log=None, cancel=None):
        assert Path(source).read_bytes() == PNG and profile == "ai-picture"
        log("sent to TV")
        Path(output).write_bytes(b"RESULT")
        return {"profile": profile, "restored": True}

    monkeypatch.setattr(server.process, "enhance_image", enhance)
    monkeypatch.setattr(server.process, "wait_for_idle", lambda transport: None)
    app = serve()
    status, job = app.json("POST", "/api/jobs?profile=ai-picture&name=../My%20Photo.png", None)
    assert status == 400  # no body
    status, head, data = app.request("POST", "/api/jobs?profile=ai-picture&name=../My%20Photo.png", PNG,
                                     {"Content-Type": "application/octet-stream"})
    job = json.loads(data)
    assert status == 202 and job["kind"] == "image" and job["name"] == "My-Photo"
    done = wait_for(app, job["id"], ("done", "failed", "cancelled"))
    assert done["state"] == "done" and done["exit_code"] == 0 and done["result"] == "/api/jobs/%s/result" % job["id"]
    assert "sent to TV" in done["log"]
    status, head, data = app.request("GET", done["result"])
    assert (status, data, head["content-type"]) == (200, b"RESULT", "image/png")
    assert head["content-disposition"] == 'attachment; filename="My-Photo-ai-picture.png"'
    status, listing = app.json("GET", "/api/jobs")
    assert listing["active"] is None and [j["id"] for j in listing["jobs"]] == [job["id"]] and "log" not in listing["jobs"][0]
    assert app.json("POST", "/api/jobs/%s/cancel" % job["id"])[0] == 409
    assert app.json("POST", "/api/jobs/%s/release" % job["id"])[0] == 409
    assert app.json("GET", "/api/jobs/nope")[0] == 404


def test_job_validation_before_the_tv(serve, monkeypatch):
    monkeypatch.setattr(server.process, "enhance_image", lambda *a, **k: (_ for _ in ()).throw(AssertionError("TV touched")))
    app = serve()
    assert app.request("POST", "/api/jobs", b"GIF89a....", {"Content-Type": "application/octet-stream"})[0] == 415
    assert app.request("POST", "/api/jobs?profile=nope", PNG, {})[0] == 400
    wav = b"RIFF\0\0\0\0WAVEfmt " + bytes(40)
    status, head, data = app.request("POST", "/api/jobs", wav, {})
    assert status == 400 and json.loads(data)["error"]  # process.input_audio rejects it synchronously
    assert not server.JOBS


def test_job_failure_is_reported_with_its_message(serve, monkeypatch):
    def enhance(*a, **k):
        raise RuntimeError("TV did not confirm processing and restoration")

    monkeypatch.setattr(server.process, "enhance_image", enhance)
    monkeypatch.setattr(server.process, "wait_for_idle", lambda transport: None)
    app = serve()
    job = json.loads(app.request("POST", "/api/jobs", PNG, {})[2])
    failed = wait_for(app, job["id"], ("done", "failed", "cancelled"))
    assert failed["state"] == "failed" and failed["exit_code"] == 1 and failed["result"] is None
    assert "did not confirm" in failed["log"]
    assert app.json("GET", "/api/jobs/%s/result" % job["id"])[0] == 409


def test_running_job_reserves_the_tv_and_can_be_cancelled(serve, monkeypatch):
    started, calls = threading.Event(), []

    def enhance(transport, source, output, profile, *, log=None, cancel=None):
        started.set()
        assert cancel.wait(10)
        raise Cancelled("cancelled")

    monkeypatch.setattr(server.process, "enhance_image", enhance)
    monkeypatch.setattr(server.process, "wait_for_idle", lambda transport: None)
    monkeypatch.setattr(server.tv, "remote", lambda *a: calls.append(a) or "ok")
    monkeypatch.setattr(server.notify, "say", lambda *a: calls.append(a) or "ok")
    app = serve()
    job = json.loads(app.request("POST", "/api/jobs", PNG, {})[2])
    assert started.wait(5)
    assert app.json("GET", "/api/jobs")[1]["active"] == job["id"]
    for method, path, body in (("POST", "/api/remote/home", None), ("GET", "/api/settings", None),
                               ("POST", "/api/notify/say", {"message": "hi"}), ("POST", "/api/overlay", {"title": "t"}),
                               ("GET", "/api/screen/stream", None)):
        status, answer = app.json(method, path, body)
        assert status == 409 and job["id"] in answer["error"], path
    assert app.request("POST", "/api/jobs", PNG, {})[0] == 409  # one job at a time
    assert calls == []
    status, cancelling = app.json("POST", "/api/jobs/%s/cancel" % job["id"])
    assert status == 202 and cancelling["state"] == "cancelling"
    final = wait_for(app, job["id"], ("done", "failed", "cancelled"))
    assert final["state"] == "cancelled" and final["outcome"] == "cancelled"
    assert app.json("GET", "/api/jobs")[1]["active"] is None


def test_unconfirmed_release_can_be_rechecked(serve, monkeypatch):
    answers = [TvBusyError("lock still held"), None]

    def idle(transport):
        answer = answers.pop(0)
        if answer:
            raise answer

    def enhance(transport, source, output, profile, *, log=None, cancel=None):
        Path(output).write_bytes(b"R")
        return {}

    monkeypatch.setattr(server.process, "enhance_image", enhance)
    monkeypatch.setattr(server.process, "wait_for_idle", idle)
    app = serve()
    job = json.loads(app.request("POST", "/api/jobs", PNG, {})[2])
    stuck = wait_for(app, job["id"], ("release_unconfirmed", "done"))
    assert stuck["state"] == "release_unconfirmed" and "lock still held" in stuck["release_error"]
    assert app.json("GET", "/api/jobs")[1]["active"] == job["id"]  # the TV stays reserved
    assert app.json("POST", "/api/jobs/%s/release" % job["id"])[0] == 202
    assert wait_for(app, job["id"], ("done",))["state"] == "done"


# ---- main()

def test_main_generate_token(capsys):
    assert server.main(["--generate-token"]) == 0
    token = capsys.readouterr().out.strip()
    assert len(token) >= 32 and " " not in token


def test_main_refuses_non_loopback_without_a_token(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path / "empty"))
    assert server.main(["--host", "0.0.0.0", "--port", "0"]) == 2
    assert "token" in capsys.readouterr().err
