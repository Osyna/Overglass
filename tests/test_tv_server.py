"""Offline tests for tv-server/ (the Node server that runs on the TV itself) and its boot hook.

Everything runs locally: the real server.js is started under `node` on 127.0.0.1:0 (an ephemeral port, never 8766),
WOF_TV_DISPATCH points at a small sh script that fakes dispatch.sh's reply for each verb, and the web root, config and
log live in a temp dir. No TV, no network beyond loopback, no sound. The tests are Node-driven but invoked from pytest
(`python3 -m pytest tests/test_tv_server.py`); tv-server/ itself holds nothing but the two files that ship to the TV.
"""
import base64
import http.client
import json
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "tv-server" / "server.js"
HOOK = ROOT / "tv-server" / "init.d-hook.sh"
NODE = shutil.which("node")
SHELL = shutil.which("sh")
TOKEN = "t0ken-" + "x" * 30
NOTICE = "No token set yet"
DISABLED_NOTE = "Login is off: anyone who can reach this server can control the TV."

pytestmark = pytest.mark.skipif(NODE is None or SHELL is None, reason="needs node and sh")

# Fakes dispatch.sh: reads the request from $SSH_ORIGINAL_COMMAND like the real one, logs it, answers per verb.
# Flag files in $FAKE_DIR switch on failure modes (busy, fail, stream_fail, stream_hang, app_fail, status.out).
FAKE_DISPATCH = r"""#!/bin/sh
cmd=$SSH_ORIGINAL_COMMAND
echo "$cmd" >> "$FAKE_DIR/calls.log"
[ -e "$FAKE_DIR/busy" ] && { echo "TV is busy with AI processing or another change; try again shortly." >&2; exit 75; }
[ -e "$FAKE_DIR/fail" ] && { echo "luna exploded" >&2; exit 1; }
set -f
set -- $cmd
case $1 in
  status)
    if [ -e "$FAKE_DIR/status.out" ]; then cat "$FAKE_DIR/status.out"; else
      echo '{"returnValue":true,"state":"Active"}'
      echo '{"returnValue":true,"appId":"com.webos.app.hdmi1"}'
      echo '{"id":"com.webos.app.home","main":"index.html"}'
      echo '{"temperature_millicelsius":45000,"temperature_source":"soc"}'
      echo; echo @@@
      echo '{"returnValue":true,"volumeStatus":{"volume":10,"maxVolume":100,"muteStatus":false}}'
    fi ;;
  details)
    echo '{"lux":3,"panel_hours":1234,"panel_temperature_c":31,"pixel_refresher":{},"power_on_reason":"Remote","power_history":[],"signal":null,"sleep_timer":"Off","usage_today":[]}' ;;
  remote)
    case $2 in hdmi) echo "\"Switched to HDMI $3\"" ;; *) echo "{\"message\":\"Sent $2\"}" ;; esac ;;
  settings-list)
    echo '[{"category":"sound","key":"aiSound","value":"on","values":["on","off"],"available":true,"context":{}},{"category":"aiPicture","key":"ai_Picture","value":"off","values":["on","off"],"available":false,"context":{"input":"hdmi1"}}]' ;;
  settings-set) echo '"on (persists)"' ;;
  notify-toast) echo '{"returnValue":true}' ;;
  notify-say) echo 'log line'; echo '{"returnValue":true,"spoke":11,"volume":15}' ;;
  notify-overlay) echo '{"returnValue":true,"overlay":"shown"}' ;;
  screenshot)
    case $4 in png) printf '\211PNG\r\n\032\nIMG' ;; *) printf '\377\330\377IMG' ;; esac ;;
  stream-start)
    [ -e "$FAKE_DIR/stream_fail" ] && { echo "vtcap: no role" >&2; exit 1; }
    echo $$ > "$FAKE_DIR/stream.pid"
    printf 'C5F1\240\000Z\000'
    head -c 43200 /dev/zero | tr '\0' '\7'
    if [ -e "$FAKE_DIR/stream_hang" ]; then exec sleep 60; fi
    head -c 43200 /dev/zero | tr '\0' '\7' ;;
  app-list) echo '[{"id":"com.example.app","title":"Example","icon":"icon.png","version":"1.0","removable":true}]' ;;
  app-install)
    if [ -e "$FAKE_DIR/app_fail" ]; then echo '{"returnValue":false,"errorText":"Download failed"}'; else
      echo '{"returnValue":true,"statusText":"Downloading...","progress":50}'; echo '{"returnValue":true,"statusText":"Finished"}'; fi ;;
  app-uninstall)
    if [ -e "$FAKE_DIR/app_fail" ]; then echo '{"returnValue":false,"errorText":"No such app"}'; else echo '{"returnValue":true}'; fi ;;
  *) echo "webos-foundry: unknown request" >&2; exit 64 ;;
esac
"""

STATUS_VARIANTS = {
    "hdmi": None,  # the default document in FAKE_DISPATCH
    "standby": '{"returnValue":true,"state":"Active Standby"}\n{"returnValue":false}\n{}\n'
               '{"temperature_millicelsius":null,"temperature_source":null}\n\n@@@\n{"returnValue":false}\n',
    "luma": '{"returnValue":true,"state":"Active"}\n{"returnValue":true,"appId":"com.webos.app.home"}\n'
            '{"id":"com.webos.app.home","main":"/media/luma"}\n'
            '{"temperature_millicelsius":52500,"temperature_source":"soc"}\n\n@@@\n'
            '{"returnValue":true,"volumeStatus":{"volume":0,"maxVolume":100,"muteStatus":true}}\n',
    "other_app": '{"returnValue":true,"state":"Screen Saver"}\n{"returnValue":true,"appId":"netflix"}\n[]\n'
                 '{"temperature_millicelsius":500,"temperature_source":"soc"}\n\n@@@\n'
                 '{"returnValue":true,"volumeStatus":{"volume":5,"maxVolume":100,"muteStatus":false}}\n',
}


def b64(text):
    return base64.b64encode(text.encode()).decode()


class TvServer:
    """A real `node server.js` on an ephemeral loopback port with a fake dispatcher."""

    def __init__(self, tmp, config="seed", web=True):
        self.tmp = tmp
        self.fake_dir = tmp / "fake"
        self.fake_dir.mkdir()
        self.dispatch = tmp / "dispatch.sh"
        self.dispatch.write_text(FAKE_DISPATCH)
        self.web = tmp / "web"
        if web:
            (self.web / "sub").mkdir(parents=True)
            (self.web / "index.html").write_text("<!doctype html><title>placeholder UI</title>")
            (self.web / "app.css").write_text("body{}")
            (self.web / "app.js").write_text("console.log(1)")
            (self.web / "sub" / "icon.svg").write_text("<svg/>")
            (self.web / "blob.bin").write_bytes(b"\0\1")
        (tmp / "secret.txt").write_text("outside the web root")
        if web:
            os.symlink(tmp / "secret.txt", self.web / "escape.txt")
        self.config = tmp / "tvconf" / "config.json"
        self.config.parent.mkdir()
        if config == "seed":
            self.write_config({"token": TOKEN, "auth_mode": "token"})
        elif config is not None:
            self.config.write_text(config)
        self.log = tmp / "server.log"
        env = {**os.environ, "WOF_TV_DISPATCH": str(self.dispatch), "WOF_TV_WEB": str(self.web),
               "WOF_TV_CONFIG": str(self.config), "WOF_TV_LOG": str(self.log), "WOF_TV_HOST": "127.0.0.1",
               "WOF_TV_PORT": "0", "FAKE_DIR": str(self.fake_dir)}
        self.proc = subprocess.Popen([NODE, str(SERVER)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.stdout = self.proc.stdout.readline()
        assert "listening on http://127.0.0.1:" in self.stdout, self.stdout + (self.proc.stderr.read() if self.proc.poll() else "")
        self.port = int(self.stdout.rsplit(":", 1)[1])

    def write_config(self, data):
        self.config.write_text(json.dumps(data))
        self.config.chmod(0o600)

    def flag(self, name, on=True):
        path = self.fake_dir / name
        path.touch() if on else path.unlink()

    def calls(self):
        path = self.fake_dir / "calls.log"
        return path.read_text().splitlines() if path.exists() else []

    def conn(self):
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)

    def request(self, method, path, body=None, headers=None, auth=True):
        send = dict(headers or {})
        if auth is True:
            send.setdefault("Authorization", "Bearer " + TOKEN)
        elif auth:
            send["Authorization"] = auth
        conn = self.conn()
        try:
            conn.request(method, path, body=body, headers=send)
            response = conn.getresponse()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        finally:
            conn.close()

    def json(self, method, path, body=None, headers=None, auth=True):
        send = dict(headers or {})
        if body is not None:
            send.setdefault("Content-Type", "application/json")
            body = json.dumps(body)
        status, head, data = self.request(method, path, body, send, auth)
        return status, json.loads(data)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc.stdout.close()
        self.proc.stderr.close()


@pytest.fixture
def make(tmp_path_factory):
    started = []

    def factory(**kwargs):
        server = TvServer(tmp_path_factory.mktemp("tvsrv"), **kwargs)
        started.append(server)
        return server

    yield factory
    for server in started:
        server.stop()


@pytest.fixture
def tv(make):
    return make()


# ---------------------------------------------------------------- syntax

def test_node_syntax():
    subprocess.run([NODE, "--check", str(SERVER)], check=True)


def test_hook_syntax_and_mode():
    subprocess.run([SHELL, "-n", str(HOOK)], check=True)
    assert HOOK.stat().st_mode & 0o111 and SERVER.stat().st_mode & 0o111


def test_no_personal_data():
    import re
    bad = re.compile(r"slopbro|192\.168\.8|6C:15:DB|LGTV|lg-c5|c5-|c5_|net\.slopbro", re.I)
    for path in (SERVER, HOOK):
        assert not bad.search(path.read_text()), path


def test_tv_server_dir_ships_only_two_files():
    assert sorted(p.name for p in (ROOT / "tv-server").iterdir() if p.name != "__pycache__") == ["init.d-hook.sh", "server.js"]


# ---------------------------------------------------------------- catalogue

def test_catalogue_has_no_processing_group(tv):
    status, catalogue = tv.json("GET", "/api", auth=False)  # GET /api needs no token
    assert status == 200
    assert set(catalogue) >= {"tv", "base", "auth", "errors", "kinds", "routes"}
    assert catalogue["kinds"] == {} and catalogue["tv"] == {"address": "127.0.0.1"}
    routes = {(r["method"], r["path"]): r for r in catalogue["routes"]}
    assert {r["group"] for r in routes.values()} == {"Reference", "Status", "Notify", "Remote", "Picture & sound", "Apps", "Settings"}
    assert not any("/api/jobs" in path for _, path in routes) and "Processing" not in {r["group"] for r in routes.values()}
    for key in [("GET", "/api"), ("GET", "/api/health"), ("GET", "/api/status"), ("GET", "/api/details"),
                ("POST", "/api/notify/toast"), ("POST", "/api/notify/say"), ("POST", "/api/overlay"),
                ("GET", "/api/screenshot"), ("GET", "/api/screen/stream"), ("POST", "/api/remote/{action}"),
                ("GET", "/api/settings"), ("PUT", "/api/settings/{category}/{key}"), ("GET", "/api/apps"),
                ("POST", "/api/apps"), ("DELETE", "/api/apps/{id}"), ("GET", "/api/config/auth"),
                ("PATCH", "/api/config/auth")]:
        assert key in routes, key
        assert {"method", "path", "group", "summary"} <= set(routes[key])
        assert "handler" not in routes[key] and "regex" not in routes[key] and "names" not in routes[key]
    # The gap is stated in the catalogue itself, in the GET /api entry and a top-level list.
    assert "Processing" in routes[("GET", "/api")]["notes"] and "/api/jobs" in routes[("GET", "/api")]["notes"]
    assert catalogue["unavailable"][0]["group"] == "Processing" and "/api/jobs" in catalogue["unavailable"][0]["paths"]
    wake = [v["name"] for v in routes[("POST", "/api/remote/{action}")]["values"]]
    assert "wake" not in wake and "hdmi" in wake and len(wake) == 13
    assert tv.json("GET", "/api/jobs")[0] == 404  # no such route


def test_health_is_always_paired_local(tv):
    assert tv.json("GET", "/api/health", auth=False) == (200, {"paired": True, "tv_host": "127.0.0.1"})


# ---------------------------------------------------------------- routes and dispatcher strings

def test_status_shape_and_command(tv):
    status, body = tv.json("GET", "/api/status")
    assert status == 200
    assert body == {"power": "on", "raw_power_state": "Active", "app_id": "com.webos.app.hdmi1", "source": "HDMI 1",
                    "is_luma": False, "temperature_c": 45, "temperature_source": "soc", "volume": 10, "muted": False}
    assert tv.calls() == ["status"]
    assert list(body) == ["power", "raw_power_state", "app_id", "source", "is_luma", "temperature_c", "temperature_source",
                          "volume", "muted"]


@pytest.mark.parametrize("variant", sorted(STATUS_VARIANTS))
def test_status_matches_python_parser(tv, variant):
    tv_module = pytest.importorskip("webos_foundry.tv")
    raw = STATUS_VARIANTS[variant]
    if raw is None:
        status, body = tv.json("GET", "/api/status")
        raw = "".join(l + "\n" for l in ['{"returnValue":true,"state":"Active"}', '{"returnValue":true,"appId":"com.webos.app.hdmi1"}',
                                          '{"id":"com.webos.app.home","main":"index.html"}',
                                          '{"temperature_millicelsius":45000,"temperature_source":"soc"}', "", "@@@",
                                          '{"returnValue":true,"volumeStatus":{"volume":10,"maxVolume":100,"muteStatus":false}}'])
    else:
        (tv.fake_dir / "status.out").write_text(raw)
        status, body = tv.json("GET", "/api/status")
    assert status == 200
    assert body == tv_module.parse_status(raw)


def test_status_errors(tv):
    (tv.fake_dir / "status.out").write_text("not json")
    status, body = tv.json("GET", "/api/status")
    assert status == 502 and "error" in body
    (tv.fake_dir / "status.out").write_text(STATUS_VARIANTS["luma"].replace('"volumeStatus"', '"nothing"'))
    status, body = tv.json("GET", "/api/status")  # TV on but no volume: never a guess
    assert status == 502 and "Volume status unavailable" in body["error"]


def test_details(tv):
    status, body = tv.json("GET", "/api/details")
    assert status == 200 and body["panel_hours"] == 1234 and body["signal"] is None and body["sleep_timer"] == "Off"
    assert tv.calls() == ["details"]


@pytest.mark.parametrize("action,expect", [("home", "remote home"), ("power_off", "remote power_off"),
                                           ("volume_up", "remote volume_up"), ("unmute", "remote unmute")])
def test_remote_actions(tv, action, expect):
    status, body = tv.json("POST", "/api/remote/" + action)
    assert (status, body) == (200, {"action": action, "message": "Sent " + action})
    assert tv.calls() == [expect]


def test_remote_hdmi_and_validation(tv):
    assert tv.json("POST", "/api/remote/hdmi", {"value": 3}) == (200, {"action": "hdmi", "message": "Switched to HDMI 3"})
    assert tv.calls() == ["remote hdmi 3"]
    for body in ({"value": 0}, {"value": 5}, {"value": "2"}, {"value": True}, {}):
        assert tv.json("POST", "/api/remote/hdmi", body)[0] == 400, body
    assert tv.json("POST", "/api/remote/home", {"value": 1})[0] == 400
    assert tv.json("POST", "/api/remote/launch_missiles")[0] == 404
    assert len(tv.calls()) == 1  # nothing invalid reached the dispatcher


def test_wake_is_refused_honestly(tv):
    status, body = tv.json("POST", "/api/remote/wake")
    assert status == 501 and "Wake-on-LAN" in body["error"] and tv.calls() == []


def test_settings_list_sorted_and_set(tv):
    status, body = tv.json("GET", "/api/settings")
    assert status == 200 and [(i["category"], i["key"]) for i in body] == [("aiPicture", "ai_Picture"), ("sound", "aiSound")]
    assert body[0]["label"] == "AI Picture Pro" and body[1]["label"] == "AI Sound"
    status, reply = tv.json("PUT", "/api/settings/sound/aiSound", {"value": "on", "context": {"input": "hdmi1"}})
    assert (status, reply) == (200, {"message": "AI Sound: on (persists)"})
    verb, category, key, payload = tv.calls()[-1].split(" ")
    assert (verb, category, key) == ("settings-set", "sound", "aiSound")
    assert json.loads(base64.b64decode(payload)) == {"value": "on", "context": {"input": "hdmi1"}}
    for category, key, body in [("sound", "volume", {"value": "on", "context": {}}), ("sound", "aiSound", {"value": "", "context": {}}),
                                ("sound", "aiSound", {"value": "on"}), ("sound", "aiSound", {"value": "on", "context": {"a": 1}}),
                                ("sound", "aiSound", {"value": 1, "context": {}})]:
        assert tv.json("PUT", "/api/settings/%s/%s" % (category, key), body)[0] == 400, (key, body)
    assert tv.json("GET", "/api/settings/sound/aiSound")[0] == 405


def test_toast_say_overlay(tv):
    assert tv.json("POST", "/api/notify/toast", {"message": " Dinner is ready "}) == (200, {"message": "Toast shown on the TV"})
    assert tv.calls()[-1] == "notify-toast " + b64("Dinner is ready")
    status, body = tv.json("POST", "/api/notify/say", {"message": "Dinner"})
    assert status == 200 and body["message"].startswith("Spoke 11 characters at volume 15;")
    assert tv.calls()[-1] == "notify-say %s 15" % b64("Dinner")
    tv.json("POST", "/api/notify/say", {"message": "Dinner", "volume": 7})
    assert tv.calls()[-1] == "notify-say %s 7" % b64("Dinner")
    for body in ({}, {"message": ""}, {"message": "x" * 201}, {"message": "a\nb"}, {"message": 5}, {"message": "é" * 151}):
        assert tv.json("POST", "/api/notify/toast", body)[0] == 400, body
    for volume in (0, 41, "10", 1.5, True):
        assert tv.json("POST", "/api/notify/say", {"message": "hi", "volume": volume})[0] == 400, volume
    card = {"title": " Door ", "lines": ["a"], "kind": "alert", "seconds": 0}
    assert tv.json("POST", "/api/overlay", card) == (200, {"message": "Overlay card shown"})
    verb, payload = tv.calls()[-1].split(" ")
    assert verb == "notify-overlay" and json.loads(base64.b64decode(payload)) == {"title": "Door", "lines": ["a"], "kind": "alert", "seconds": 0}
    assert tv.json("POST", "/api/overlay", {"hide": True})[0] == 200
    assert json.loads(base64.b64decode(tv.calls()[-1].split(" ")[1])) == {"hide": True}
    n = len(tv.calls())
    for bad in ({}, {"title": "x", "extra": 1}, {"title": "x" * 81}, {"title": "x", "kind": "red"}, {"title": "x", "seconds": 1.5},
                {"image": "ftp://x"}, {"hide": True, "title": "x"}, {"lines": "no"}, {"title": "x", "seconds": 301}):
        assert tv.json("POST", "/api/overlay", bad)[0] == 400, bad
    assert len(tv.calls()) == n


def test_screenshot(tv):
    status, head, data = tv.request("GET", "/api/screenshot")
    assert status == 200 and head["content-type"] == "image/jpeg" and data == b"\xff\xd8\xffIMG" and head["cache-control"] == "no-store"
    assert tv.calls() == ["screenshot 1920 1080 jpg"]
    status, head, data = tv.request("GET", "/api/screenshot?width=960&format=png")
    assert status == 200 and head["content-type"] == "image/png" and data.startswith(b"\x89PNG")
    assert tv.calls()[-1] == "screenshot 960 540 png"
    tv.request("GET", "/api/screenshot?width=80")  # Python rounds the half down to even (22), so 44 high
    assert tv.calls()[-1] == "screenshot 80 44 jpg"
    n = len(tv.calls())
    for query in ("width=abc", "width=63", "width=3842", "width=1921", "format=gif", "width=62"):
        assert tv.request("GET", "/api/screenshot?" + query)[0] == 400, query
    assert len(tv.calls()) == n


def test_screenshot_height_matches_python(tv):
    server_py = pytest.importorskip("webos_foundry.server")
    for width in (64, 80, 96, 160, 960, 1280, 1920, 3840):
        tv.request("GET", "/api/screenshot?width=%d" % width)
        assert tv.calls()[-1] == "screenshot %d %d jpg" % server_py.screenshot_args({"width": str(width)})[:2], width


def test_stream(tv):
    conn = tv.conn()
    try:
        conn.request("GET", "/api/screen/stream", headers={"Authorization": "Bearer " + TOKEN})
        response = conn.getresponse()
        assert response.status == 200 and response.getheader("Content-Type") == "application/octet-stream"
        assert response.getheader("Content-Length") is None
        data = response.read()
    finally:
        conn.close()
    assert data[:8] == b"WOF1\xa0\x00Z\x00"  # rewritten magic, u16le 160, u16le 90
    assert len(data) == 8 + 2 * 43200 and set(data[8:]) == {7}
    assert tv.calls() == ["stream-start 160 90 30 0 2"]
    tv.request("GET", "/api/screen/stream?width=320&height=180&fps=10")
    assert tv.calls()[-1] == "stream-start 320 180 10 0 2"
    for query in ("width=161", "fps=9", "fps=61", "width=160&height=91", "fps=x"):
        assert tv.request("GET", "/api/screen/stream?" + query)[0] == 400, query


def test_stream_start_failure_is_json_error(tv):
    tv.flag("stream_fail")
    status, body = tv.json("GET", "/api/screen/stream")
    assert status == 502 and "vtcap: no role" in body["error"]


def test_stream_stops_the_tv_process_when_viewer_leaves_and_allows_one_at_a_time(tv):
    tv.flag("stream_hang")
    conn = tv.conn()
    conn.request("GET", "/api/screen/stream", headers={"Authorization": "Bearer " + TOKEN})
    response = conn.getresponse()
    assert response.status == 200 and response.read(8) == b"WOF1\xa0\x00Z\x00"
    assert tv.json("GET", "/api/screen/stream")[0] == 409
    pid = int((tv.fake_dir / "stream.pid").read_text())
    os.kill(pid, 0)  # alive while watching
    conn.close()
    for _ in range(100):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(pid, signal.SIGKILL)
        pytest.fail("the TV-side stream process survived the viewer leaving")
    tv.flag("stream_hang", False)
    for _ in range(50):  # the slot frees once the process is reaped
        if tv.request("GET", "/api/screen/stream")[0] == 200:
            break
        time.sleep(0.1)
    else:
        pytest.fail("stream slot never freed")


def test_apps(tv):
    status, apps = tv.json("GET", "/api/apps")
    assert status == 200 and apps == [{"id": "com.example.app", "title": "Example", "icon": "icon.png", "version": "1.0", "removable": True}]
    assert tv.calls() == ["app-list"]
    sha = "ab" * 32
    status, body = tv.json("POST", "/api/apps", {"url": "https://example.org/a.ipk", "sha256": sha})
    assert (status, body) == (200, {"message": "App installed"})
    verb, payload = tv.calls()[-1].split(" ")
    assert verb == "app-install"
    assert base64.b64decode(payload).decode() == '{"url":"https://example.org/a.ipk","sha256":"%s"}' % sha  # compact, key order fixed
    assert tv.json("POST", "/api/apps", {"url": "http://example.org/b.ipk"})[0] == 200
    assert base64.b64decode(tv.calls()[-1].split(" ")[1]).decode() == '{"url":"http://example.org/b.ipk"}'  # no sha256 key
    assert tv.json("DELETE", "/api/apps/com.example.app") == (200, {"message": "App removed"})
    assert tv.calls()[-1] == "app-uninstall " + b64("com.example.app")
    n = len(tv.calls())
    for bad in ({}, {"url": "ftp://x/a.ipk"}, {"url": "https://x/" + "a" * 500}, {"url": "https://x/a b"},
                {"url": "https://x/a.ipk", "sha256": "AB" * 32}, {"url": "https://x/a.ipk", "sha256": "ab"},
                {"url": "https://x/a.ipk", "extra": 1}, {"url": 5}):
        assert tv.json("POST", "/api/apps", bad)[0] == 400, bad
    for app_id in ("a%20b", "a;b", "-x", "a%2Fb"):
        assert tv.json("DELETE", "/api/apps/" + app_id)[0] in (400, 404), app_id
    assert len(tv.calls()) == n
    # A raw IPK body is the PC server's second shape; here it is refused with the reason.
    status, head, data = tv.request("POST", "/api/apps", b"IPKBYTES", {"Content-Type": "application/octet-stream"})
    assert status == 415 and "not supported" in json.loads(data)["error"]
    tv.flag("app_fail")
    status, body = tv.json("POST", "/api/apps", {"url": "https://example.org/a.ipk"})
    assert status == 502 and body["error"] == "Download failed"
    status, body = tv.json("DELETE", "/api/apps/com.example.app")
    assert status == 502 and body["error"] == "No such app"


def test_every_command_is_accepted_by_the_dispatcher_grammar(tv):
    dispatcher = pytest.importorskip("webos_foundry.dispatcher")
    for action in ("home", "power_off", "volume_down", "mute"):
        tv.json("POST", "/api/remote/" + action)
    tv.json("POST", "/api/remote/hdmi", {"value": 4})
    tv.json("GET", "/api/status")
    tv.json("GET", "/api/details")
    tv.json("GET", "/api/settings")
    tv.json("PUT", "/api/settings/aiPicture/ai_Brightness", {"value": "on", "context": {"input": "hdmi1", "pictureMode": "cinema"}})
    tv.json("POST", "/api/notify/toast", {"message": "Dîner prêt"})
    tv.json("POST", "/api/notify/say", {"message": "é" * 150, "volume": 40})
    tv.json("POST", "/api/overlay", {"title": "T", "body": "B", "lines": ["x"], "image": "https://example.org/i.png", "seconds": 300})
    tv.request("GET", "/api/screenshot?width=3840&format=png")
    tv.request("GET", "/api/screenshot?width=64")
    tv.request("GET", "/api/screen/stream?width=320&height=180&fps=60")
    calls = tv.calls()
    assert len(calls) == 15
    for call in calls:
        assert dispatcher.verb_of(call), call


def test_dispatcher_busy_and_failure(tv):
    tv.flag("busy")
    status, body = tv.json("POST", "/api/remote/home")
    assert status == 409 and "busy" in body["error"]
    tv.flag("busy", False)
    tv.flag("fail")
    status, body = tv.json("POST", "/api/remote/home")
    assert status == 502 and body["error"] == "luna exploded"


def test_missing_dispatcher_is_a_clean_502(tv):
    tv.dispatch.unlink()
    status, body = tv.json("GET", "/api/details")
    assert status in (502,) and "error" in body


def test_tv_commands_do_not_overlap(tv):
    # remote/settings/say hold one lock: two clients' commands run one after the other, never interleaved.
    import threading
    (tv.tmp / "dispatch.sh").write_text(FAKE_DISPATCH.replace("set -f", "echo start >> \"$FAKE_DIR/order\"; sleep 0.3; echo end >> \"$FAKE_DIR/order\"\nset -f"))
    threads = [threading.Thread(target=tv.json, args=("POST", "/api/remote/home")) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert (tv.fake_dir / "order").read_text().split() == ["start", "end"] * 3


# ---------------------------------------------------------------- http plumbing

def test_method_and_path_errors(tv):
    assert tv.json("GET", "/api/nope") == (404, {"error": "No such endpoint; GET /api lists them"})
    status, body = tv.json("DELETE", "/api/status")
    assert status == 405 and "GET" in body["error"]
    assert tv.json("POST", "/api/remote")[0] == 404


def test_body_rules(tv):
    h = {"Content-Type": "application/json"}
    assert tv.request("POST", "/api/notify/toast", b"[1]", h)[0] == 400
    assert tv.request("POST", "/api/notify/toast", b"{oops", h)[0] == 400
    assert tv.request("POST", "/api/notify/toast", b"", h)[0] == 400
    assert tv.request("POST", "/api/notify/toast", b'{"message":"x"}', {"Content-Type": "text/plain"})[0] == 415
    assert tv.request("POST", "/api/notify/toast", b"x" * (64 * 1024 + 1), h)[0] == 413
    conn = tv.conn()
    conn.request("POST", "/api/notify/toast", iter([b'{"message":"x"}']), {**h, "Authorization": "Bearer " + TOKEN}, encode_chunked=True)
    response = conn.getresponse()
    assert response.status == 411 and "Content-Length" in json.loads(response.read())["error"]
    conn.close()
    assert tv.calls() == []


def test_cross_site_writes_are_refused(tv):
    h = {"Content-Type": "application/json"}
    body = json.dumps({"message": "x"})
    assert tv.request("POST", "/api/notify/toast", body, {**h, "Origin": "http://evil.example"})[0] == 403
    assert tv.request("POST", "/api/notify/toast", body, {**h, "Sec-Fetch-Site": "cross-site"})[0] == 403
    assert tv.request("POST", "/api/notify/toast", body, {**h, "Origin": "http://127.0.0.1:%d" % tv.port})[0] == 200
    assert tv.request("POST", "/api/notify/toast", body, {**h, "Sec-Fetch-Site": "same-origin"})[0] == 200
    assert tv.request("GET", "/api/status", None, {"Origin": "http://evil.example"})[0] == 200  # reads stay open to the token


def test_security_headers(tv):
    _, head, _ = tv.request("GET", "/api/health", auth=False)
    assert "default-src 'none'" in head["content-security-policy"] and head["x-content-type-options"] == "nosniff"
    assert head["cache-control"] == "no-store" and head["referrer-policy"] == "no-referrer"


# ---------------------------------------------------------------- static serving

def test_static_files(tv):
    status, head, data = tv.request("GET", "/", auth=False)  # the UI needs no token
    assert status == 200 and head["content-type"] == "text/html; charset=utf-8" and b"placeholder UI" in data
    assert tv.request("GET", "/index.html", auth=False)[0] == 200
    assert tv.request("GET", "/app.css", auth=False)[1]["content-type"] == "text/css; charset=utf-8"
    assert tv.request("GET", "/app.js", auth=False)[1]["content-type"] == "text/javascript; charset=utf-8"
    assert tv.request("GET", "/sub/icon.svg", auth=False)[1]["content-type"] == "image/svg+xml"
    assert tv.request("GET", "/blob.bin", auth=False)[1]["content-type"] == "application/octet-stream"
    assert tv.request("GET", "/sub/")[0] == 404  # a directory without index.html
    assert tv.request("GET", "/nope.html", auth=False)[0] == 401  # unknown paths need the token, like every non-public route


@pytest.mark.parametrize("path", ["/../secret.txt", "/%2e%2e/secret.txt", "/sub/../../secret.txt", "/..%2fsecret.txt",
                                  "/escape.txt", "/sub", "/%00", "/sub%5c..%5c..%5csecret.txt", "/nope.html", "/%zz"])
def test_static_is_traversal_safe(tv, path):
    for auth in (True, False):
        status, _, data = tv.request("GET", path, auth=auth)
        assert status == (404 if auth else 401) and b"outside the web root" not in data


def test_static_never_shadows_the_api(tv):
    (tv.web / "api").mkdir()
    (tv.web / "api" / "status").write_text("shadow")
    assert tv.request("GET", "/api/status", auth=False)[0] == 401


# ---------------------------------------------------------------- auth, first boot, disabled mode

def test_token_mode(tv):
    assert tv.json("GET", "/api/status", auth=None)[0] == 401
    status, head, data = tv.request("GET", "/api/status", auth=None)
    assert head["www-authenticate"] == "Bearer" and "Missing bearer token" in json.loads(data)["error"]
    assert tv.json("GET", "/api/status", auth="Bearer wrong")[0] == 401
    assert tv.json("GET", "/api/status", auth="Bearer " + TOKEN[:-1])[0] == 401
    assert tv.json("GET", "/api/status", auth="Basic " + TOKEN)[0] == 401
    assert tv.json("GET", "/api/status", auth="bearer " + TOKEN)[0] == 200
    for route in ("/api/details", "/api/settings", "/api/apps", "/api/config/auth", "/api/screenshot"):
        assert tv.request("GET", route, auth=None)[0] == 401, route
    assert tv.request("POST", "/api/remote/home", auth=None)[0] == 401
    assert tv.calls() == ["status"]  # only the one authorized call above reached the dispatcher
    assert tv.json("GET", "/api/health", auth=None)[0] == 200 and tv.json("GET", "/api", auth=None)[0] == 200
    assert tv.json("GET", "/api/config/auth") == (200, {"mode": "token", "note": ""})


def test_disabled_mode_needs_no_token(make):
    tv = make(config=json.dumps({"token": TOKEN, "auth_mode": "disabled"}))
    assert tv.json("GET", "/api/config/auth", auth=None) == (200, {"mode": "disabled", "note": DISABLED_NOTE})
    assert tv.json("GET", "/api/status", auth=None)[0] == 200
    assert tv.json("POST", "/api/remote/home", auth=None)[0] == 200
    assert tv.json("GET", "/api/status", auth="Bearer wrong")[0] == 200  # not even a wrong token matters


def test_patch_auth_mode_persists_and_validates(tv):
    assert tv.json("PATCH", "/api/config/auth", {"mode": "disabled"})[0] == 400  # confirm missing
    assert tv.json("PATCH", "/api/config/auth", {"mode": "disabled", "confirm": "true"})[0] == 400  # not literally true
    assert tv.json("PATCH", "/api/config/auth", {"mode": "open", "confirm": True})[0] == 400
    assert tv.json("PATCH", "/api/config/auth", {"confirm": True})[0] == 400
    assert tv.json("GET", "/api/config/auth") == (200, {"mode": "token", "note": ""})
    assert tv.json("PATCH", "/api/config/auth", None, auth=None)[0] == 401  # normal auth still guards the route
    assert tv.json("PATCH", "/api/config/auth", {"mode": "disabled", "confirm": True}) == (200, {"mode": "disabled", "note": DISABLED_NOTE})
    assert json.loads(tv.config.read_text()) == {"token": TOKEN, "auth_mode": "disabled"}  # token kept
    assert (tv.config.stat().st_mode & 0o777) == 0o600 and not tv.config.with_name("config.json.new").exists()
    assert tv.json("GET", "/api/status", auth=None)[0] == 200  # takes effect at once
    assert tv.json("PATCH", "/api/config/auth", {"mode": "token", "confirm": True}, auth=None) == (200, {"mode": "token", "note": ""})
    assert tv.json("GET", "/api/status", auth=None)[0] == 401
    assert tv.json("GET", "/api/status")[0] == 200


def test_first_boot_generates_token_and_logs_it_once(make):
    tv = make(config=None)
    assert tv.config.exists() and (tv.config.stat().st_mode & 0o777) == 0o600
    config = json.loads(tv.config.read_text())
    assert config["auth_mode"] == "token" and len(config["token"]) >= 32
    log = tv.log.read_text()
    assert log.count(config["token"]) == 1 and (tv.log.stat().st_mode & 0o777) == 0o600
    assert config["token"] not in tv.stdout  # never on stdout
    assert tv.json("GET", "/api/status", auth=None)[0] == 401
    assert tv.json("GET", "/api/status", auth="Bearer " + config["token"])[0] == 200
    assert tv.request("GET", "/", auth=None)[0] == 200


def test_restart_keeps_the_token(make, tmp_path):
    tv = make(config=None)
    token = json.loads(tv.config.read_text())["token"]
    tv.stop()
    again = subprocess.Popen([NODE, str(SERVER)], env={**os.environ, "WOF_TV_DISPATCH": str(tv.dispatch), "WOF_TV_WEB": str(tv.web),
                             "WOF_TV_CONFIG": str(tv.config), "WOF_TV_LOG": str(tv.log), "WOF_TV_HOST": "127.0.0.1",
                             "WOF_TV_PORT": "0"}, stdout=subprocess.PIPE, text=True)
    try:
        assert "listening" in again.stdout.readline()
        assert json.loads(tv.config.read_text())["token"] == token and tv.log.read_text().count(token) == 1
    finally:
        again.terminate()
        again.wait(timeout=10)
        again.stdout.close()


def test_notice_page_while_no_token_exists(make):
    tv = make(config=None)
    tv.config.unlink()  # the token file disappears (or was never writable): only the notice is served
    status, head, data = tv.request("GET", "/", auth=None)
    assert status == 200 and head["content-type"].startswith("text/html") and NOTICE.encode() in data
    assert b"/tmp/webos-foundry-tv-server.log" in data and b"wof config show" in data
    assert b"placeholder UI" not in data and b"<script" not in data  # not the real app
    for path in ("/app.js", "/index.html", "/api", "/api/health", "/api/status", "/api/config/auth"):
        status, _, data = tv.request("GET", path, auth=None)
        assert status == 503 and NOTICE in json.loads(data)["error"], path
    assert tv.request("POST", "/api/remote/home")[0] == 503 and tv.calls() == []
    tv.write_config({"token": TOKEN, "auth_mode": "token"})  # a config with a token appears: real app, with auth
    assert tv.request("GET", "/", auth=None)[2].count(b"placeholder UI") == 1
    assert tv.json("GET", "/api/status", auth=None)[0] == 401 and tv.json("GET", "/api/status")[0] == 200


def test_unwritable_config_serves_only_the_notice(make, tmp_path):
    tv = make(config=None)
    tv.stop()
    env = {**os.environ, "WOF_TV_DISPATCH": str(tv.dispatch), "WOF_TV_WEB": str(tv.web), "WOF_TV_HOST": "127.0.0.1", "WOF_TV_PORT": "0",
           "WOF_TV_CONFIG": str(tmp_path / "no-such-dir" / "config.json"), "WOF_TV_LOG": str(tmp_path / "l.log")}
    proc = subprocess.Popen([NODE, str(SERVER)], env=env, stdout=subprocess.PIPE, text=True)
    try:
        port = int(proc.stdout.readline().rsplit(":", 1)[1])
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", "/")
        response = conn.getresponse()
        assert response.status == 200 and NOTICE.encode() in response.read()
        conn.request("GET", "/api/status", headers={"Authorization": "Bearer anything"})
        assert conn.getresponse().status == 503
        assert "cannot write" in (tmp_path / "l.log").read_text()
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        proc.stdout.close()


@pytest.mark.parametrize("config", ["not json", "[]", "{}", '{"token": ""}', '{"token": "abc", "auth_mode": "open"}', '{"token": 5}'])
def test_invalid_config_fails_closed_to_the_notice(make, config):
    tv = make(config=config)
    assert tv.config.read_text() == config  # never overwritten
    assert NOTICE.encode() in tv.request("GET", "/", auth=None)[2]
    assert tv.request("GET", "/api/status", auth=None)[0] == 503


# ---------------------------------------------------------------- boot hook (shim node, local sh)

@pytest.fixture
def hook(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "node").write_text('#!/bin/sh\ntrap \'kill $c 2>/dev/null; exit 0\' TERM\nsleep 120 &\nc=$!\nwait\n')
    (bin_dir / "node").chmod(0o755)
    tree = tmp_path / "tv-server"
    tree.mkdir()
    (tree / "server.js").write_text("// shim target\n")
    env = {**os.environ, "PATH": "%s:%s" % (bin_dir, os.environ["PATH"]), "WOF_TV_DIR": str(tree),
           "WOF_TV_PIDFILE": str(tmp_path / "x.pid"), "WOF_TV_LOG": str(tmp_path / "x.log")}
    pids = []

    def run(*args):
        return subprocess.run([SHELL, str(HOOK), *args], env=env, capture_output=True, text=True, timeout=30)

    run.pidfile = tmp_path / "x.pid"
    run.tree = tree
    run.pids = pids
    yield run
    for pid in [*pids, *([int(run.pidfile.read_text())] if run.pidfile.exists() else [])]:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def reaped(pid, seconds=5):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.05)
    return False


def test_hook_start_is_reentrant_and_stop_cleans_up(hook):
    first = hook("start")
    assert first.returncode == 0, first.stderr
    pid1 = int(hook.pidfile.read_text())
    assert alive(pid1)
    hook.pids.append(pid1)
    second = hook()  # no argument means start; the old server is killed first
    assert second.returncode == 0, second.stderr
    pid2 = int(hook.pidfile.read_text())
    assert pid2 != pid1 and alive(pid2) and reaped(pid1)
    hook.pids.append(pid2)
    assert hook("stop").returncode == 0
    assert not hook.pidfile.exists() and reaped(pid2)
    assert hook("stop").returncode == 0  # nothing to stop is fine


def test_hook_never_kills_a_process_it_did_not_start(hook):
    stranger = subprocess.Popen(["sleep", "60"])
    try:
        hook.pidfile.write_text(str(stranger.pid))  # a stale pid file whose number was reused by something else
        assert hook("start").returncode == 0
        assert stranger.poll() is None
        hook.pids.append(int(hook.pidfile.read_text()))
        hook.pidfile.write_text(str(stranger.pid))
        assert hook("stop").returncode == 0 and stranger.poll() is None and not hook.pidfile.exists()
    finally:
        stranger.kill()
        stranger.wait()
    hook.pidfile.write_text("not-a-pid")
    assert hook("stop").returncode == 0 and not hook.pidfile.exists()


def test_hook_reports_failure(hook):
    (hook.tree / "server.js").unlink()
    result = hook("start")
    assert result.returncode == 1 and "server.js is missing" in result.stderr
    assert hook("bogus").returncode == 2
