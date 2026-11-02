"""HTTP API and web UI for a rooted LG webOS TV.

`wof serve` (or `python -m webos_foundry.server`) serves http://127.0.0.1:8765/. The page in web/ is only a client
of the /api routes below; GET /api returns their catalogue, including what each route does on the TV. All TV
access goes through one SSHTransport built from the saved config (webos_foundry.tv / notify / capture / process);
file processing runs in a worker thread per job.

Auth: bound to a loopback address a bearer token is optional (but must be right when sent); bound anywhere else
it is required. GET /api, GET /api/health and the static UI files never need one. With auth_mode "disabled" in
the config (PATCH /api/config/auth) no route ever needs one, on any bind: GET /api/config/auth reports it.
"""
import argparse
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import struct
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import AF_INET6
from urllib.parse import parse_qs, unquote, urlsplit

from webos_foundry import addons, apps, capture, notify, pairing, process, scenes, schedule, tv, webhooks
from webos_foundry.config import AUTH_MODES, Config
from webos_foundry.errors import ConfigError, NotPairedError, TransportError, TvBusyError, WebosFoundryError
from webos_foundry.transport import SSHTransport

WEB = Path(__file__).resolve().parent.parent / "web"
TYPES = {  # extension -> content type of the files served from web/
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
}
UPLOAD_RE = re.compile(r"/uploads/([0-9a-f]{32})\.ipk")  # unguessable id = the capability the TV fetches an upload by
PUBLIC = ("/api", "/api/health")  # no bearer token, ever
LOCAL = PUBLIC + ("/api/config/auth", "/api/pair")  # answered from this server's own state; no TV or pairing needed
NOT_PAIRED = "Not paired; run: wof pair --host <ip>"
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; "
       "font-src 'self'; media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; "
       "frame-ancestors 'none'")
MAX_JSON = 64 * 1024
MAX_UPLOAD = 16 * 1024 * 1024
MAX_IPK = 128 * 1024 * 1024
KEEP_JOBS = 20  # finished jobs whose files stay downloadable until the server stops
ACTIVE = ("running", "cancelling", "restoring", "release_unconfirmed")
PROFILE_LABELS = {
    "ai-picture-sr": "AI Picture Pro + Super Resolution",
    "ai-picture": "AI Picture Pro",
    "ai-sound": "AI Sound Pro",
    "clear-voice": "Clear Voice Pro",
    "standard": "Standard (no AI, baseline)",
}
KINDS = {
    "image": {
        "ext": ".png", "type": "image/png", "profiles": process.IMAGE_PROFILES,
        "limits": "8-bit PNG or JPEG, 16:9 with even dimensions up to 1920×1080, at most 16 MiB; never resized. "
                  "Sent to the TV as lossy H.264 8-bit 4:2:0 and shown on screen while it processes. "
                  "Returns a 3840×2160 PNG captured from the TV's video plane.",
        "tv": "process-image.js plays the image in com.webos.app.mediadiscovery, applies the profile in Normal mode, "
              "captures it with luna://com.webos.service.capture/executeOneShot, then restores picture mode and settings",
    },
    "audio": {
        "ext": ".wav", "type": "audio/wav", "profiles": process.AUDIO_PROFILES,
        "limits": "Stereo 48 kHz signed 16-bit PCM WAV, 1–30 s, at most 8 MiB, not silent. HDMI 4 must be disconnected; "
                  "speakers stay muted. Returns a peak-normalized 32-bit WAV; capture precision is low.",
        "tv": "process-audio.js switches to the HDMI 4 context, applies the sound profile, mutes the speakers, plays the file "
              "through PulseAudio and records SoundEngineCapture (hw:LGSIC,3), then restores input, sound and volume",
    },
}
KEY = "luna://com.webos.service.networkinput/sendSpecialKey"
VOLUME = "luna://com.webos.service.audio/master/"
REMOTE = {
    "wake": ("Wake from standby (Wake-on-LAN)",
             "UDP magic packet for the configured TV MAC to the configured broadcast address. Sending does not prove "
             "the TV woke: read /api/status"),
    "power_off": ("Standby", "luna://com.webos.service.tvpower/power/powerOff, then getPowerState until Active Standby"),
    "home": ("Home key; opens Luma", KEY + ' {"key":"HOME"}, then waits for com.webos.app.home in front'),
    "back": ("Back key", KEY + ' {"key":"BACK"}'),
    "up": ("Up key", KEY + ' {"key":"UP"}'),
    "down": ("Down key", KEY + ' {"key":"DOWN"}'),
    "left": ("Left key", KEY + ' {"key":"LEFT"}'),
    "right": ("Right key", KEY + ' {"key":"RIGHT"}'),
    "ok": ("OK key", KEY + ' {"key":"ENTER"}'),
    "hdmi": ("Switch input; body {\"value\": 1-4}",
             'luna://com.webos.applicationManager/launch {"id":"com.webos.app.hdmiN"}, then getForegroundAppInfo until it is in front'),
    "volume_up": ("Volume +1 on the TV speaker", VOLUME + "setVolume, then getVolume readback"),
    "volume_down": ("Volume −1 on the TV speaker", VOLUME + "setVolume, then getVolume readback"),
    "mute": ("Mute the TV speaker", VOLUME + 'muteVolume {"mute":true}, then getVolume readback'),
    "unmute": ("Unmute the TV speaker", VOLUME + 'muteVolume {"mute":false}, then getVolume readback'),
}
TV_LOCK_NOTE = ("Runs as one node process on the TV under /tmp/webos-foundry.lock, the lock processing jobs hold, "
                "so a check-change-readback cannot interleave with another client.")

LOCK = threading.RLock()  # job table and job fields
TV_LOCK = threading.Lock()  # one TV command from this server at a time
JOBS = {}
STREAM_LOCK = threading.Lock()  # one live view at a time
STREAM_STOP = threading.Event()  # set when the server stops
STREAM_SIZES = {160: 90, 320: 180}
STREAM_MAX_SECONDS = 600
ROOT = None  # private temporary directory for uploads and results, created on first upload, removed on exit


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Job:
    def __init__(self, kind, profile, name):
        self.id = secrets.token_hex(4)
        self.kind, self.profile, self.name = kind, profile, name
        self.state, self.outcome, self.exit_code = "running", None, None
        self.created, self.finished = time.time(), None
        self.recovery, self.release_error = None, None
        self.log = []
        self.cancel = threading.Event()
        self.dir = self.output = self.thread = None


def sniff(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image", ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio", ".wav"
    raise ApiError(415, "Upload a PNG, JPEG or WAV file")


def safe_stem(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", Path(name).stem).strip(".-")[:60] or "upload"


def is_loopback(host):
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.lower() == "localhost"


def allowed_hosts(bind, port):
    """Host header values this server answers to; None (any) for a wildcard bind, where the token is the defence."""
    if bind in ("", "0.0.0.0", "::"):
        return None
    names = {bind} | ({"127.0.0.1", "localhost", "::1"} if is_loopback(bind) else set())
    return {("[%s]:%d" if ":" in name else "%s:%d") % (name, port) for name in names}


def caller_error(method, host, origin, fetch_site, hosts):
    """Refuse DNS-rebound Host names and cross-site browser writes. `hosts` is allowed_hosts(), None = any Host."""
    if hosts is not None and host not in hosts:
        return 421, "Unexpected Host header; use one of: " + ", ".join(sorted(hosts))
    if method != "GET":
        if origin is not None and origin not in {"http://" + h for h in (hosts if hosts is not None else {host})}:
            return 403, "Cross-origin requests are refused"
        if fetch_site not in (None, "same-origin", "none"):
            return 403, "Cross-site requests are refused"
    return None


def bearer(header):
    scheme, _, value = (header or "").partition(" ")
    return value.strip() if scheme.lower() == "bearer" and value.strip() else None


def is_static(path):
    return path != "/api" and not path.startswith("/api/")


def static_file(path):
    """The regular file under web/ that `path` names, or None. Never outside web/ (.. and escaping symlinks)."""
    rel = unquote(path).lstrip("/") or "index.html"
    root = WEB.resolve()
    target = (root / rel).resolve() if "\0" not in rel and not rel.endswith("/") else None
    if target is None or target.suffix.lower() not in TYPES or root not in target.parents or not target.is_file():
        return None
    return target


def auth_error(path, header, token, loopback, auth_mode="token"):
    """Bearer-token check. Public paths pass; on loopback a missing token passes but a wrong one does not.
    auth_mode "disabled" (explicit opt-in, any bind) passes everything."""
    if auth_mode == "disabled" or path in PUBLIC or path.startswith("/webhook/") or is_static(path):
        return None
    presented = bearer(header)
    if loopback and not token:
        return None
    if presented is None:
        return None if loopback else (401, "Missing bearer token: send Authorization: Bearer <server_token>")
    if token and hmac.compare_digest(presented.encode(), token.encode()):
        return None
    return 401, "Invalid bearer token"


def active():
    return next((job for job in JOBS.values() if job.state in ACTIVE), None)


def reserved():
    with LOCK:
        job = active()
        if job:
            raise ApiError(409, "The TV is reserved by processing job %s (%s); wait until it is released"
                           % (job.id, job.state.replace("_", " ")))


def find(job_id):
    with LOCK:
        if job_id not in JOBS:
            raise ApiError(404, "No such job")
        return JOBS[job_id]


def snapshot(job, log=True):
    with LOCK:
        out = {"id": job.id, "kind": job.kind, "profile": job.profile, "name": job.name, "state": job.state,
               "outcome": job.outcome, "exit_code": job.exit_code, "created": job.created, "finished": job.finished,
               "recovery_workspace": job.recovery, "release_error": job.release_error,
               "result": "/api/jobs/%s/result" % job.id if job.state == "done" else None}
        if log:
            out["log"] = "".join(job.log)[-65536:]
        return out


def log_line(job, text):
    with LOCK:
        job.log.append(text.rstrip("\n") + "\n")


def run(job, transport, source):
    enhance = process.enhance_image if job.kind == "image" else process.enhance_audio
    code = 0
    try:
        info = enhance(transport, str(source), str(job.output), job.profile,
                       log=lambda text: log_line(job, text), cancel=job.cancel)
        log_line(job, json.dumps(info))
    except Exception as error:  # the worker must always reach release(), whatever the processor raised
        code = 1
        log_line(job, str(error).strip() or type(error).__name__)
    kept = re.search(r"Private TV workspace kept for recovery: (\S+)", "".join(job.log))
    with LOCK:
        job.exit_code = code
        job.recovery = kept.group(1) if kept else None
        job.outcome = ("done" if code == 0 and job.output.is_file()
                       else "cancelled" if job.cancel.is_set() else "failed")
        job.state = "restoring"
    release(job, transport)


def release(job, transport):
    """A job only ends once the TV lock is free, i.e. its TV-side process restored the TV and exited."""
    try:
        process.wait_for_idle(transport)
        error = None
    except (WebosFoundryError, RuntimeError, OSError) as failure:
        error = str(failure).strip() or type(failure).__name__
    with LOCK:
        job.release_error = error
        job.state = "release_unconfirmed" if error else job.outcome
        job.finished = time.time()


def prune():
    finished = [job for job in JOBS.values() if job.state not in ACTIVE]
    for job in finished[:max(0, len(JOBS) - KEEP_JOBS)]:
        shutil.rmtree(job.dir, ignore_errors=True)
        del JOBS[job.id]


def paired_host():
    """The configured TV host, or None when this install is not paired."""
    try:
        return Config.load().tv_host or None
    except (ConfigError, NotPairedError):
        return None


# ---- route handlers: (request, path parameters) -> dict | (status, dict) | None when already sent

def api_index(request, _):
    return {
        "tv": {"address": paired_host()},
        "base": "http://%s" % (request.headers.get("Host") or "%s:%d" % request.server.server_address[:2]),
        "auth": "Authorization: Bearer <server_token> on every route except GET /api and GET /api/health; "
                "optional on a loopback bind, required otherwise, and never required when GET /api/config/auth says "
                "mode is \"disabled\".",
        "errors": "Every non-2xx response is {\"error\": \"message\"}. 401 means the bearer token is missing or wrong; "
                  "409 means the TV is reserved by a processing job or busy with another change; 502 means the TV "
                  "refused or did not answer; 503 means this install is not paired with a TV.",
        "kinds": {kind: {"profiles": [{"id": p, "label": PROFILE_LABELS.get(p, p)} for p in spec["profiles"]],
                         "limits": spec["limits"], "returns": spec["type"]} for kind, spec in KINDS.items()},
        "routes": [{k: v for k, v in route.items() if k not in ("handler", "regex")} for route in ROUTES],
    }


def get_health(_request, _):
    host = paired_host()
    return {"paired": host is not None, "tv_host": host}


def get_status(request, _):
    return tv.get_status(request.transport)


def post_remote(request, params):
    action = params["action"]
    if action not in tv.REMOTE_ACTIONS:
        raise ApiError(404, "Unknown remote action; GET /api lists them")
    value = request.json_body(required=False).get("value")
    reserved()
    with TV_LOCK:
        return {"action": action, "message": tv.remote(request.transport, action, value)}


def get_settings(request, _):
    reserved()
    with TV_LOCK:
        return tv.get_settings(request.transport)


def put_setting(request, params):
    body = request.json_body()
    reserved()
    with TV_LOCK:
        return {"message": tv.set_setting(request.transport, params["category"], params["key"],
                                          body.get("value"), body.get("context"))}


def get_details(request, _):
    return tv.get_details(request.transport)


def post_toast(request, _):
    return {"message": notify.toast(request.transport, request.json_body().get("message"))}


def post_say(request, _):
    body = request.json_body()
    reserved()
    with TV_LOCK:
        return {"message": notify.say(request.transport, body.get("message"), body.get("volume", 15))}


def screenshot_args(query):
    try:
        width = int(query.get("width", "1920"))
    except ValueError:
        raise ValueError("width must be an integer") from None
    return width, round(width * 9 / 32) * 2, query.get("format", "jpg")  # height: 16:9, rounded to even


def get_screenshot(request, _):
    data, kind = capture.screenshot(request.transport, *screenshot_args(request.query))
    request.send_bytes(200, data, kind)


def post_overlay(request, _):
    card = request.json_body()
    reserved()
    return {"message": notify.overlay_show(request.transport, card)}


def get_scenes(_request, _):
    return {"scenes": {name: {"steps": scene["steps"]} for name, scene in scenes.load().items()}}


def put_scene(request, params):
    body = request.json_body()
    scenes.save(params["name"], scenes.check_scene(body))
    return {"message": "Scene saved"}


def delete_scene(_request, params):
    scenes.delete(params["name"])
    return {"message": "Scene deleted"}


def post_scene_run(request, params):
    saved = scenes.load()
    if params["name"] not in saved:
        raise ApiError(404, "No such scene")
    reserved()
    with TV_LOCK:
        return {"messages": scenes.run_scene(request.transport, saved[params["name"]])}


def get_webhooks(_request, _):
    return {"webhooks": webhooks.load()}


def post_webhook(request, _):
    body = request.json_body()
    if set(body) - {"scene", "label"}:
        raise ValueError("A webhook only takes scene and label")
    token = webhooks.create(body.get("scene"), body.get("label"))
    return {"token": token, "url": "/webhook/" + token, "message": "Webhook created"}


def delete_webhook(_request, params):
    webhooks.delete(params["token"])
    return {"message": "Webhook deleted"}


def get_webhook(request, params):
    entry = webhooks.resolve(params["token"])
    if entry is None:
        raise ApiError(404, "No such webhook")
    scene = scenes.load().get(entry["scene"])
    if scene is None:
        raise ApiError(404, "Webhook scene no longer exists: %s" % entry["scene"])
    reserved()
    with TV_LOCK:
        messages = scenes.run_scene(request.server.get_transport(), scene)
    return {"message": "Webhook fired: %d step(s) run" % len(messages)}


def get_schedule(_request, _):
    return {"entries": schedule.load()}


def post_schedule(request, _):
    entry_id = schedule.save(None, request.json_body())
    return {"id": entry_id, "message": "Schedule entry saved"}


def put_schedule(request, params):
    with schedule.LOCK:
        if params["id"] not in schedule.load():
            raise ApiError(404, "No such schedule entry")
        entry_id = schedule.save(params["id"], request.json_body())
    return {"id": entry_id, "message": "Schedule entry saved"}


def delete_schedule(_request, params):
    with schedule.LOCK:
        if params["id"] not in schedule.load():
            raise ApiError(404, "No such schedule entry")
        schedule.delete(params["id"])
    return {"message": "Schedule entry deleted"}


def get_addons(_request, _):
    return {"catalog": addons.catalog(), "installed": addons.load()}


def put_addon(request, params):
    with addons.LOCK:
        entry = addons.install(params["id"], request.json_body())
    return {"message": "Addon installed", "entry": entry}


def delete_addon(_request, params):
    with addons.LOCK:
        if params["id"] not in addons.load():
            raise ApiError(404, "No such installed addon")
        addons.uninstall(params["id"])
    return {"message": "Addon uninstalled"}


def post_addon_preview(request, params):
    body = request.json_body(required=False)
    reserved()
    return {"message": addons.preview(params["id"], body.get("params", {}), request.transport)}


def stream_args(query):
    try:
        width = int(query.get("width", "160"))
        height = int(query.get("height", STREAM_SIZES.get(width, 0)))
        fps = int(query.get("fps", "30"))
    except ValueError:
        raise ValueError("width, height and fps must be integers") from None
    if STREAM_SIZES.get(width) != height:
        raise ValueError("Size must be 160×90 or 320×180")
    if not 10 <= fps <= 60:
        raise ValueError("fps must be 10-60")
    return width, height, fps


def get_stream(request, _):
    args = stream_args(request.query)
    reserved()
    if not STREAM_LOCK.acquire(blocking=False):
        raise ApiError(409, "A live view is already running; stop it first")
    frames, started = None, False
    try:
        frames = capture.stream(request.transport, *args)
        first = next(frames, None)  # a start-up failure still reaches the client as a JSON error
        if first is None:
            raise RuntimeError("The TV stopped the stream before the first frame")
        request.send_response(200)
        for name, value in (("Content-Type", "application/octet-stream"), ("Cache-Control", "no-store"),
                            ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
                            ("Content-Security-Policy", CSP)):
            request.send_header(name, value)
        request.end_headers()
        started = True
        width, height, frame = first
        request.wfile.write(b"WOF1" + struct.pack("<HH", width, height))
        deadline = time.monotonic() + STREAM_MAX_SECONDS
        while True:
            request.wfile.write(frame)
            nxt = next(frames, None)
            if nxt is None or STREAM_STOP.is_set() or time.monotonic() > deadline:
                break
            frame = nxt[2]
    except (BrokenPipeError, ConnectionResetError):
        pass  # the viewer left
    except Exception:
        if not started:
            raise
        traceback.print_exc()  # headers are out: all that is left is to end the stream
    finally:
        if frames is not None and hasattr(frames, "close"):
            frames.close()  # stops the TV-side client before the next stream may start
        STREAM_LOCK.release()


def get_jobs(_request, _):
    with LOCK:
        jobs, current = list(JOBS.values())[::-1], active()
        return {"active": current.id if current else None, "jobs": [snapshot(job, log=False) for job in jobs]}


def post_job(request, _):
    data = request.raw_body(MAX_UPLOAD)
    kind, ext = sniff(data)
    profiles = KINDS[kind]["profiles"]
    profile = request.query.get("profile", profiles[0])
    if profile not in profiles:
        raise ApiError(400, "A %s profile must be one of: %s" % (kind, ", ".join(profiles)))
    if kind == "audio":
        process.input_audio(data)  # same contract as the processor, rejected (400) before the TV is touched
    job = Job(kind, profile, safe_stem(request.query.get("name", "upload")))
    with TV_LOCK, LOCK:  # TV_LOCK: never start while a remote/settings command is still running
        reserved()
        root = work_root()
        job.dir = Path(tempfile.mkdtemp(prefix=job.id + "-", dir=root))
        source = job.dir / ("input" + ext)
        source.write_bytes(data)
        job.output = job.dir / ("result" + KINDS[kind]["ext"])
        job.thread = threading.Thread(target=run, args=(job, request.transport, source), daemon=True)
        JOBS[job.id] = job
        prune()
    job.thread.start()
    return 202, snapshot(job)


def get_job(_request, params):
    return snapshot(find(params["id"]))


def post_cancel(_request, params):
    job = find(params["id"])
    with LOCK:
        if job.state != "running":
            raise ApiError(409, "Only a running job can be cancelled; this one is " + job.state.replace("_", " "))
        job.state = "cancelling"
        job.cancel.set()  # the processor checks it between steps; a TV-side step already running finishes first
    return 202, snapshot(job)


def post_release(request, params):
    job = find(params["id"])
    with LOCK:
        if job.state != "release_unconfirmed":
            raise ApiError(409, "Release is only rechecked after it could not be confirmed")
        job.state = "restoring"
    threading.Thread(target=release, args=(job, request.transport), daemon=True).start()
    return 202, snapshot(job)


def get_result(request, params):
    job = find(params["id"])
    with LOCK:
        state = job.state
    if state != "done" or not job.output.is_file():
        raise ApiError(409, "No result: the job is " + state.replace("_", " "))
    request.send_bytes(200, job.output.read_bytes(), KINDS[job.kind]["type"],
                       "%s-%s%s" % (job.name, job.profile, KINDS[job.kind]["ext"]))


def work_root():
    """Private temporary directory for uploads and results, created on first use, removed on exit."""
    global ROOT
    with LOCK:
        if ROOT is None:
            ROOT = Path(tempfile.mkdtemp(prefix="wof-web-"))
        return ROOT


def get_apps(request, _):
    return apps.list_apps(request.transport)


def post_app(request, _):
    if request.headers.get("Content-Type", "").split(";")[0].strip() == "application/json":
        body = request.json_body()
        return {"message": apps.install_app(request.transport, body.get("url"), body.get("sha256") or None)}
    data = request.raw_body(MAX_IPK)
    host = request.headers.get("Host") or ""
    try:
        hostname = urlsplit("//" + host).hostname
    except ValueError:
        hostname = None
    if not hostname or is_loopback(hostname):
        raise ApiError(400, "The TV fetches the upload from this server: open the UI by the computer's LAN address, "
                            "not localhost")
    name = safe_stem(request.query.get("name", "app"))
    uploads = work_root() / "uploads"
    uploads.mkdir(exist_ok=True)
    stored = uploads / (secrets.token_hex(16) + ".ipk")
    stored.write_bytes(data)
    try:
        apps.install_app(request.transport, "http://%s/uploads/%s" % (host, stored.name), hashlib.sha256(data).hexdigest())
    finally:
        stored.unlink(missing_ok=True)
    return {"message": "Installed " + name}


def delete_app(request, params):
    return {"message": apps.uninstall_app(request.transport, params["id"])}


AUTH_NOTES = {"token": "", "disabled": "Login is off: anyone who can reach this server can control the TV."}


def auth_state(mode):
    return {"mode": mode, "note": AUTH_NOTES[mode]}


def get_auth(request, _):
    return auth_state(request.server.auth_mode)


def patch_auth(request, _):
    body = request.json_body()
    if body.get("confirm") is not True:
        raise ApiError(400, 'Send "confirm": true to change the login mode')
    mode = body.get("mode")
    if mode not in AUTH_MODES:
        raise ApiError(400, "mode must be one of: " + ", ".join(AUTH_MODES))
    if mode == "token" and not request.server.token and not request.server.loopback:
        raise ApiError(400, "Set server_token in the config (or start with --token) before turning login back on")
    config = Config.load()  # ConfigError (no saved config) answers 503
    config.auth_mode = mode
    config.save()
    request.server.auth_mode = mode
    print("Login mode is now %s%s" % (mode, " (anyone who can reach this server controls the TV)" if mode == "disabled" else ""),
          flush=True)
    return auth_state(mode)


def post_pair(request, _):
    """Pair with a TV entirely from the browser: the one-time root key is written to a private temp file for the
    single SSH exchange pairing.pair() needs, then deleted; it is never saved, logged, or kept past this request."""
    if not request.server.loopback:
        raise ApiError(403, "Pairing only works from this computer: open http://127.0.0.1:%d/ here, not the LAN "
                            "address (the root key never leaves the machine running the server)" % request.server.server_address[1])
    body = request.json_body()
    key, port = body.get("key"), body.get("port", 22)
    if not isinstance(key, str) or not key.strip():
        raise ApiError(400, "Paste or upload the TV's root SSH private key")
    fd, path = tempfile.mkstemp(prefix="webos-foundry-pair-")
    try:
        os.chmod(path, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(key if key.endswith("\n") else key + "\n")
        config = pairing.pair(body.get("host"), path, port=port if isinstance(port, int) else 22)
    finally:
        os.unlink(path)
    with request.server.transport_lock:
        request.server.transport = None  # the next request builds a fresh SSHTransport with the new restricted key
    return {"message": "Paired with %s" % config.tv_host, "tv_host": config.tv_host}


def route(method, path, group, summary, handler, **doc):
    pattern = re.compile("^" + re.sub(r"\\\{(\w+)\\\}", r"(?P<\1>[^/]+)", re.escape(path)) + "$")
    return {"method": method, "path": path, "group": group, "summary": summary, **doc,
            "handler": handler, "regex": pattern}


ROUTES = (
    route("GET", "/api", "Reference", "This catalogue: TV address, processing profiles and every route.", api_index,
          returns="Catalogue object", tv=[], notes="Needs no token.", example={"path": "/api"}),
    route("GET", "/api/health", "Reference",
          "Whether this install is paired with a TV, and its address. The only route besides GET /api that needs no token.",
          get_health,
          returns='{"paired": bool, "tv_host": str | null}', tv=[],
          notes="Reads the saved config only; it never contacts the TV, so it answers while the TV is off.",
          example={"path": "/api/health"}),
    route("POST", "/api/pair", "Setup",
          "Pair with a TV using its root SSH key: the one-time setup step, done entirely from the browser.",
          post_pair,
          body='{"host": "IP or hostname", "key": "root SSH private key, PEM/OpenSSH text", "port"?: 22}',
          returns='{"message": str, "tv_host": str}',
          tv=["uses the pasted root key once over SSH to write dispatch.sh and append a dedicated restricted key "
              "to /home/root/.ssh/authorized_keys, then pushes every TV script with the new restricted key"],
          notes="Loopback only, regardless of auth_mode: the root key is accepted only from this computer, never "
                "over the LAN, and is never saved, logged, or sent anywhere but the TV.",
          example={"path": "/api/pair", "body": {"host": "192.168.1.50", "key": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n"}}),
    route("GET", "/api/status", "Status", "Power, foreground source, Luma, SoC temperature, volume and mute.", get_status,
          returns='{"power": "on|off|unknown", "raw_power_state", "source": "HDMI 1|Luma|LG Home|Off|…", "app_id", '
                  '"is_luma", "temperature_c", "temperature_source", "volume", "muted"} — volume/muted are null in standby',
          tv=["dispatch verb status → sh /var/lib/webosbrew/webos-foundry/status.sh: "
              "luna://com.webos.service.tvpower/power/getPowerState, "
              "luna://com.webos.applicationManager/getForegroundAppInfo, the mounted Home manifest (Luma check), "
              "/proc/thermalinfo/soc_temperature",
              VOLUME + "getVolume"],
          notes="Read-only; does not take the TV lock, so it also works while a job runs.",
          example={"path": "/api/status"}),
    route("GET", "/api/details", "Status",
          "OLED panel hours and temperature, pixel refresher runs, power-on reason and history, ambient light, "
          "input signal, sleep timer and today's app usage.", get_details,
          returns='{"lux": int, "panel_hours": int, "panel_temperature_c": int (whole °C), "pixel_refresher": '
                  '{"full_runs", "full_last_panel_hours", "standby_runs", "standby_last_panel_hours"}, "power_on_reason": str, '
                  '"power_history": [{"reason", "panel_hours"}] newest first (10), "signal": {"app_id", "width", "height", '
                  '"fps", "hdr", "pixel_encoding", "timing", "content_type", "game_mode", "allm", "vrr"}, '
                  '"sleep_timer": str, "usage_today": [{"app_id", "seconds", "launches"}]} — a field is null when its '
                  'TV service did not answer, and the signal is null when no source is connected',
          tv=["dispatch verb details → node details.js (≈0.7 s): pqcontroller/getInfo {key: eyeQLux}, "
              "oledepl/getOledPanelUTT, getPanelTemperature, getPixelRefresherInfoList, tvpower/power/getPowerOnReason, "
              "micomservice/listPowerOnOffHistoryWithUTT, videooutput/getStatus, settings/getSystemSettings (time.sleepTimer), "
              "usercontextmanager/getRank"],
          notes="Read-only and takes no TV lock, so it also works while a job runs. Never calls a setter, refresher or reset.",
          example={"path": "/api/details"}),
    route("POST", "/api/notify/toast", "Notify", "Show a message on the TV screen as a toast.", post_toast,
          body='{"message": "1-200 characters, no control characters"}',
          returns='{"message": "Toast shown on the TV"}',
          tv=["dispatch verb notify-toast → node notify.js toast BASE64: luna://com.webos.notification/createToast "
              '{"message", "persistent": false, "noaction": true}'],
          notes="Takes no TV lock and does not change any setting.",
          example={"path": "/api/notify/toast", "body": {"message": "Dinner is ready"}}),
    route("POST", "/api/notify/say", "Notify",
          "Speak a message through the TV speaker (text to speech) at a chosen volume, then restore the TV.", post_say,
          body='{"message": "1-200 characters, no control characters", "volume": 1-40 (optional, default 15)}',
          returns='{"message": "Spoke N characters at volume V; …restored"}',
          tv=["dispatch verb notify-say → node notify.js say BASE64 VOLUME: borrows option.audioGuidance "
              "(settings/setSystemSettings), audio/master/setVolume and muteVolume, speaks with "
              "luna://com.webos.service.tts/speak {text, clear}, then restores all three and reads them back"],
          notes=TV_LOCK_NOTE + " Answers 409 while a processing job holds the TV. It needs TV-speaker output and the TV on; "
                               "volume is on the TV's 0-100 scale.",
          example={"path": "/api/notify/say", "body": {"message": "Dinner is ready", "volume": 10}}),
    route("POST", "/api/overlay", "Notify",
          "Show a custom card on the TV, built from your own JSON layout of widgets, or hide it.",
          post_overlay,
          body='Either {"hide": true} alone, or {"position"?, "size"?, "seconds"?, "root": <widget tree>}, or the '
               'shorthand {"title"?, "body"?, "lines"?, "image"?, "kind"?, "position"?, "size"?, "seconds"?} compiled '
               'into an equivalent tree. position: top-left|top-right|bottom-left|bottom-right|center (default '
               'top-right). size: xs|s|m|l|xl|full (default m). seconds: 0-300, 0 = stays until hidden (default 8). '
               'A widget node is {"type": stack|row|text|image|badge|dot|progress|countdown|list|divider, '
               '...fields, "children"?: [...] for stack/row}; depth ≤ 4, ≤ 40 widgets total, ≤ 32768 bytes of JSON. '
               'Full per-type field list: ARCHITECTURE.md section 3a.',
          returns='{"message": "Overlay card shown|hidden"}',
          tv=["dispatch verb notify-overlay → node notify.js overlay: reads the tree from stdin (not inline — a "
              "rich tree can exceed dropbear's inline-command limit), checks the TV is on, re-validates the tree, then "
              'luna://com.webos.applicationManager/launch {"id": "dev.webosfoundry.overlay", "params": card} '
              "(app installed by wof install, source tv-assets/overlay/)"],
          notes="The foreground app does not change (HDMI 1 stays in front). The first card after a cold start takes "
                "about 2.5 s to appear; later cards update it in place. A remote button press while a card is up "
                "dismisses it and is consumed, not passed to the input. The TV must be on; an invalid card or a TV in "
                "standby answers 502 with the TV script's message. Answers 409 while a processing job holds the TV. "
                "The image URL is fetched by the TV, so it must be reachable from the TV.",
          example={"path": "/api/overlay", "body": {"title": "Dinner", "body": "It is ready.", "kind": "success",
                                                    "position": "top-right", "seconds": 10}}),
    route("GET", "/api/scenes", "Scenes", "Every saved scene with its steps.", get_scenes,
          returns='{"scenes": {name: {"steps": [step, ...]}}}', tv=[],
          notes="Reads this server's own state; never contacts the TV.", example={"path": "/api/scenes"}),
    route("PUT", "/api/scenes/{name}", "Scenes",
          "Save a scene: a named sequence of 1-20 steps, run together in order by POST .../run.", put_scene,
          body='{"steps": [step, ...]}. A step is one of: {"type": "remote", "action", "value"?} (see '
               'POST /api/remote/{action}), {"type": "setting", "category", "key", "value", "context"?} (see '
               'PUT /api/settings/{category}/{key}), {"type": "overlay", "card"} (see POST /api/overlay, any '
               'shorthand or widget-tree body), or {"type": "wait", "seconds": 0-10}.',
          returns='{"message": "Scene saved"}', tv=[],
          notes="The overlay step's card is validated and compiled into a widget tree right here, at save time, "
                "not every time the scene runs. A name is 1-60 characters with no leading/trailing space.",
          example={"path": "/api/scenes/movie-night", "body": {"steps": [
              {"type": "setting", "category": "sound", "key": "aiSound", "value": "off", "context": {}},
              {"type": "overlay", "card": {"title": "Movie night", "kind": "info", "seconds": 5}}]}}),
    route("DELETE", "/api/scenes/{name}", "Scenes", "Remove a saved scene.", delete_scene,
          returns='{"message": "Scene deleted"}', tv=[],
          notes="404 if no scene has that name.", example={"path": "/api/scenes/movie-night"}),
    route("POST", "/api/scenes/{name}/run", "Scenes",
          "Run every step of a saved scene, in order, stopping at the first failure.", post_scene_run,
          returns='{"messages": [one per completed step]}',
          tv=["one dispatch call per remote/setting/overlay step, in order; a wait step sleeps here and makes no call"],
          notes=TV_LOCK_NOTE + " Answers 409 while a processing job holds the TV, 404 if no scene has that name, "
                               "and 502 (with the TV's message) at the step that failed; earlier steps already ran.",
          example={"path": "/api/scenes/movie-night/run"}),
    route("GET", "/api/webhooks", "Webhooks", "List webhook tokens, scenes and display labels.", get_webhooks,
          returns='{"webhooks": {token: {"scene": str, "label": str}}}', tv=[],
          notes="Normal API authentication; full tokens remain available for copying. Local storage only.",
          example={"path": "/api/webhooks"}),
    route("POST", "/api/webhooks", "Webhooks", "Create a revocable URL for one saved scene.", post_webhook,
          body='{"scene": "1-60 characters", "label"?: "at most 60 characters"}',
          returns='{"token": str, "url": "/webhook/<token>", "message": "Webhook created"}', tv=[],
          notes="Normal API authentication. The scene is looked up when triggered, not when created.",
          example={"path": "/api/webhooks", "body": {"scene": "movie-night", "label": "Movie night"}}),
    route("DELETE", "/api/webhooks/{token}", "Webhooks", "Revoke one webhook URL.", delete_webhook,
          returns='{"message": "Webhook deleted"}', tv=[],
          notes="Normal API authentication; 400 for an unknown token.",
          example={"path": "/api/webhooks/WEBHOOK_TOKEN"}),
    route("GET", "/webhook/{token}", "Webhooks", "Run the one scene granted by this capability URL.", get_webhook,
          returns='{"message": "Webhook fired: N step(s) run"}',
          tv=["runs the saved scene steps in order, stopping on the first failure"],
          notes="Public: the URL token is the credential; no bearer token. Anyone with it can run this scene. "
                "Delete the webhook to revoke it. 404 for unknown tokens or a deleted scene. "
                "409 while the TV is reserved; 502 for TV failures.",
          example={"path": "/webhook/WEBHOOK_TOKEN"}),
    route("GET", "/api/schedule", "Schedule", "List local scene schedules.", get_schedule,
          returns='{"entries": {id: {"id", "scene", "time", "days", "enabled"}}}', tv=[],
          notes="Local storage only; no pairing or TV connection needed.", example={"path": "/api/schedule"}),
    route("POST", "/api/schedule", "Schedule", "Create a local scene schedule.", post_schedule,
          body='{"scene": str, "time": "HH:MM", "days"?: ["mon", ..., "sun"], "enabled"?: bool}',
          returns='{"id": str, "message": "Schedule entry saved"}', tv=[],
          notes="Local time; omitted or empty days means every day, enabled defaults to true. "
                "The scene need not exist yet. Runs only while wof serve is running.",
          example={"path": "/api/schedule", "body": {"scene": "movie-night", "time": "20:00", "days": ["mon"]}}),
    route("PUT", "/api/schedule/{id}", "Schedule", "Replace an existing local schedule entry.", put_schedule,
          body='{"scene": str, "time": "HH:MM", "days"?: ["mon", ..., "sun"], "enabled"?: bool}',
          returns='{"id": str, "message": "Schedule entry saved"}', tv=[],
          notes="404 if the entry does not exist; never contacts the TV.",
          example={"path": "/api/schedule/example", "body": {"scene": "movie-night", "time": "21:00"}}),
    route("DELETE", "/api/schedule/{id}", "Schedule", "Delete a local schedule entry.", delete_schedule,
          returns='{"message": "Schedule entry deleted"}', tv=[],
          notes="404 if the entry does not exist; never contacts the TV.", example={"path": "/api/schedule/example"}),
    route("GET", "/api/addons", "Addons",
          "The full addon catalog (every registered connector) and what is currently installed.", get_addons,
          returns='{"catalog": [{"id", "name", "description", "category", "params_schema", '
                  '"default_interval_seconds"}], "installed": {id: {"params", "interval_seconds", "enabled", '
                  '"position"?, "size"?}}}',
          tv=[], notes="Local storage only; never contacts the TV.", example={"path": "/api/addons"}),
    route("PUT", "/api/addons/{id}", "Addons",
          "Install (or update) an addon. wof serve polls it on interval_seconds and shows the result while "
          "enabled -- the one-click 'it just stays live' install.", put_addon,
          body='{"params": {...this addon\'s params_schema}, "interval_seconds"? 15-3600, "enabled"? bool '
               "(default true), \"position\"?, \"size\"?}",
          returns='{"message": "Addon installed", "entry": {...}}', tv=[],
          notes="Only one overlay window can be visible at a time: enabling this addon disables every other "
                "installed addon. 400 for an unknown id or bad settings; never contacts the TV.",
          example={"path": "/api/addons/football", "body": {"params": {"league": "bl1"}, "interval_seconds": 90}}),
    route("DELETE", "/api/addons/{id}", "Addons", "Uninstall an addon; stops its background refresh.",
          delete_addon, returns='{"message": "Addon uninstalled"}', tv=[],
          notes="404 if it is not installed; never contacts the TV.", example={"path": "/api/addons/football"}),
    route("POST", "/api/addons/{id}/preview", "Addons",
          "Poll an addon once and show it now, without installing or changing saved settings.", post_addon_preview,
          body='{"params"?: {...this addon\'s params_schema, defaults to {} }}',
          returns='{"message": "Overlay card shown"}',
          tv=["one dispatch call, exactly like POST /api/overlay, with the addon's generated card"],
          notes=TV_LOCK_NOTE, example={"path": "/api/addons/football/preview", "body": {"params": {"league": "bl2"}}}),
    route("GET", "/api/screenshot", "Status",
          "Capture the picture the TV shows from its HDMI input (without the TV's own menus) as an image.", get_screenshot,
          query={"width": "64-3840, even (default 1920); the height follows the 16:9 picture",
                 "format": "jpg (default) or png"},
          returns="image/jpeg or image/png bytes, Cache-Control: no-store",
          tv=["dispatch verb screenshot → luna://com.webos.service.capture/executeOneShot "
              '{"method": "VIDEO", "path": "/tmp/wof-shot-RANDOM.jpg", "format", "width", "height"}, cat the file, rm it, '
              "all in one SSH command (≈0.4 s at 960, ≈0.8 s at 3840)"],
          notes="PRIVACY: this is whatever the connected PC shows (desktop, documents, messages). Nothing is stored here "
                "and the TV file is deleted, but the response is the full picture: do not share it. Copy-protected (HDCP) "
                "sources cannot be captured and answer 502.",
          example={"path": "/api/screenshot?width=960&format=jpg"}),
    route("GET", "/api/screen/stream", "Status",
          "Live low-resolution view of the HDMI picture: raw RGB frames in a close-delimited binary stream.", get_stream,
          query={"width": "160 (default) or 320", "height": "90 for width 160 (default), 180 for width 320",
                 "fps": "10-60 (default 30)"},
          returns="application/octet-stream, no Content-Length, HTTP/1.0 close-delimited: the bytes 'WOF1', u16le width, "
                  "u16le height, then frames of width*height*3 bytes of RGB24 in a row-major loop until the client "
                  "disconnects, the 10-minute cap passes or the TV stops",
          tv=["dispatch verb stream-start → native vtcap client over SSH (capture.stream): libvtcapture display-output "
              "tap at the requested size and rate; it is stopped (SIGTERM) when the stream ends. Measured "
              "30 and 60 fps at 160×90 and 320×180 with 8-23% of one TV core"],
          notes="PRIVACY: this is the connected PC's screen, live. The server keeps no frames. One stream at a time "
                "(409 while another runs), 409 while a processing job reserves the TV, 502 when the capture client "
                "cannot start (for example the vtcap role is not installed: run wof install). Close the "
                "connection to stop it. It takes no TV lock; a job started while it runs does not stop it.",
          stream=True, example={"path": "/api/screen/stream?width=160&height=90&fps=30"}),
    route("POST", "/api/remote/{action}", "Remote", "Send one remote action and wait for the TV to confirm it.", post_remote,
          body='Optional JSON. Only hdmi takes a body: {"value": 1-4}',
          returns='{"action": "…", "message": "what the TV confirmed"}',
          values=[{"name": name, "detail": detail, "tv": tv_text} for name, (detail, tv_text) in REMOTE.items()],
          tv=[], notes=TV_LOCK_NOTE + " Wake is the exception: it is a LAN broadcast from this computer.",
          example={"path": "/api/remote/hdmi", "body": {"value": 1}}),
    route("GET", "/api/settings", "Picture & sound", "The allowed AI picture and sound settings, as the TV reports them now.",
          get_settings,
          returns='[{"category", "key", "label", "value", "values": [allowed now], "available": bool, '
                  '"context": {axis: value}}] — context is the input/mode scope the value belongs to; {} means global',
          tv=["dispatch verb settings-list → node settings.js list: "
              "luna://com.webos.service.settings/getSystemSettingDesc and getSystemSettings per category"],
          values=[{"name": "%s.%s" % (c, k), "detail": label} for c, k, label in tv.SETTINGS],
          notes=TV_LOCK_NOTE, example={"path": "/api/settings"}),
    route("PUT", "/api/settings/{category}/{key}", "Picture & sound",
          "Change one setting. It persists on the TV in the scope given by its context.", put_setting,
          body='{"value": "one of values", "context": the context object from GET /api/settings}',
          returns='{"message": "…"}',
          tv=["dispatch verb settings-set → node settings.js set: rechecks context, availability and allowed values "
              "with getSystemSettingDesc/getSystemSettings, calls luna://com.webos.service.settings/setSystemSettings, "
              "then reads the value back"],
          notes=TV_LOCK_NOTE + " A changed input or picture mode since the read is refused, so a value never lands "
                               "in the wrong scope.",
          example={"path": "/api/settings/sound/aiSound", "body": {"value": "on", "context": {}}}),
    route("GET", "/api/jobs", "Processing", "Processing jobs, newest first, and the one reserving the TV.", get_jobs,
          returns='{"active": id | null, "jobs": [job without log]}', tv=[], example={"path": "/api/jobs"}),
    route("POST", "/api/jobs", "Processing",
          "Upload a PNG/JPEG or WAV (raw request body) and process it on the TV.", post_job,
          query={"profile": "processing profile for the file's kind (default: the first)",
                 "name": "original file name, used for the download name"},
          body="The file bytes (Content-Type: application/octet-stream). The kind is detected from the content.",
          returns="202 and the job. The TV is reserved until the job state is done, failed or cancelled.",
          tv=["dispatch verbs process-image / process-audio (payload piped on stdin): " + KINDS["image"]["tv"],
              KINDS["audio"]["tv"]],
          notes="One job at a time. Remote and settings routes answer 409 until the TV is released.",
          example={"path": "/api/jobs?profile=ai-picture-sr&name=photo.png", "upload": "photo.png"}),
    route("GET", "/api/jobs/{id}", "Processing", "One job with its processor log.", get_job,
          returns='{"id", "kind", "profile", "state": "running|cancelling|restoring|release_unconfirmed|done|failed|'
                  'cancelled", "outcome", "exit_code", "log", "result": download path | null, "recovery_workspace", '
                  '"release_error"}',
          tv=[], example={"path": "/api/jobs/JOB_ID"}),
    route("POST", "/api/jobs/{id}/cancel", "Processing",
          "Cancel a running job. The processor stops at its next step and the TV is restored before the job ends.",
          post_cancel,
          returns="202 and the job (state cancelling)", tv=[],
          notes="A TV-side step already running finishes first; a cancelled job saves no result. Interrupted jobs keep "
                "their private /tmp/wof-*.* workspace on the TV for recovery.",
          example={"path": "/api/jobs/JOB_ID/cancel"}),
    route("POST", "/api/jobs/{id}/release", "Processing",
          "Check again whether the TV was released after release_unconfirmed.", post_release,
          returns="202 and the job (state restoring)",
          tv=["dispatch verb idle-wait → flock on /tmp/webos-foundry.lock, waiting up to 25 s"],
          example={"path": "/api/jobs/JOB_ID/release"}),
    route("GET", "/api/jobs/{id}/result", "Processing", "Download the processed file of a done job.", get_result,
          returns="image/png (3840×2160) or audio/wav (32-bit) as an attachment", tv=[],
          example={"path": "/api/jobs/JOB_ID/result"}),
    route("GET", "/api/apps", "Apps", "Apps installed on the TV that can be removed (Homebrew and sideloaded apps).",
          get_apps,
          returns='[{"id", "title", "icon", "version", "removable": true}]',
          tv=["dispatch verb app-list → node apps.js list: luna://com.webos.applicationManager/listApps, "
              "filtered to removable apps (system apps are not removable; there is no dedicated Homebrew-app list call)"],
          notes="Read-only; takes no TV lock.", example={"path": "/api/apps"}),
    route("POST", "/api/apps", "Apps",
          "Install an app (IPK): from a URL the TV downloads itself, or from an IPK uploaded as the request body.",
          post_app,
          body='Content-Type: application/json {"url": http(s) URL ≤500 chars, "sha256"?: 64 lowercase hex chars}; or any '
               "other content type with the raw IPK bytes (at most 128 MiB) as the body",
          query={"name": "upload only: original file name, used in the reply"},
          returns='{"message": "App installed" | "Installed NAME"}',
          tv=["dispatch verb app-install → node apps.js install: downloads the URL with curl to a private TV-side "
              'temp file, sha256-checks it if given, then luna://com.webos.appInstallService/dev/install '
              '{"id": "com.ares.defaultName", "ipkUrl": <local path>, "subscribe": true}, streamed until '
              '"state":"installed" (at most 90 s)'],
          notes="Without sha256 the download is not verified. An upload is served "
                "to the TV once at /uploads/<random id>.ipk (no token: the unguessable id is the capability) and deleted "
                "afterwards; its URL uses the Host you called, so use the computer's LAN address, not localhost. "
                "Answers when the install has finished or failed, up to 90 s.",
          example={"path": "/api/apps", "body": {"url": "https://example.com/app.ipk", "sha256": "0" * 64}}),
    route("DELETE", "/api/apps/{id}", "Apps", "Uninstall an app by its id.", delete_app,
          returns='{"message": "App removed"}',
          tv=['dispatch verb app-uninstall → node apps.js uninstall: luna://com.webos.appInstallService/dev/remove '
              '{"id", "subscribe": true}, streamed until "state":"removed"'],
          notes="Any id GET /api/apps lists.", example={"path": "/api/apps/com.example.app"}),
    route("GET", "/api/config/auth", "Settings", "Whether this server asks for a login token.", get_auth,
          returns='{"mode": "token" | "disabled", "note": str}', tv=[],
          notes="Reads this server's own state; never contacts the TV. \"disabled\" means no route needs a token on any "
                "bind: show a persistent warning.", example={"path": "/api/config/auth"}),
    route("PATCH", "/api/config/auth", "Settings", "Turn the login token requirement off or back on (saved in the config).",
          patch_auth, body='{"mode": "token" | "disabled", "confirm": true}', returns='{"mode": ..., "note": str}', tv=[],
          notes="confirm must be literally true. Turning login off lets anyone on the network control the TV.",
          example={"path": "/api/config/auth", "body": {"mode": "disabled", "confirm": True}}),
)


class FoundryServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, token=None, transport=None, auth_mode="token"):
        if ":" in address[0]:
            self.address_family = AF_INET6
        super().__init__(address, Handler)
        self.token = token or None
        self.auth_mode = auth_mode
        self.loopback = is_loopback(address[0])
        self.hosts = allowed_hosts(address[0], self.server_address[1])
        self.transport = transport  # None until paired; get_transport() builds it from the saved config on demand
        self.transport_lock = threading.Lock()

    def get_transport(self):
        with self.transport_lock:
            if self.transport is None:
                self.transport = SSHTransport(Config.require())
            return self.transport


class Handler(BaseHTTPRequestHandler):
    server_version = "webos-foundry"

    def do_GET(self):
        self.dispatch()

    do_POST = do_PUT = do_DELETE = do_PATCH = do_GET  # unsupported verbs get the JSON 405/404, not http.server's HTML

    def dispatch(self):
        url = urlsplit(self.path)
        try:
            refused = caller_error(self.command, self.headers.get("Host"), self.headers.get("Origin"),
                                   self.headers.get("Sec-Fetch-Site"), self.server.hosts)
            if refused:
                raise ApiError(*refused)
            if self.command == "GET" and is_static(url.path) and not url.path.startswith("/webhook/"):
                return self.send_static(url.path)
            denied = auth_error(url.path, self.headers.get("Authorization"), self.server.token, self.server.loopback,
                                self.server.auth_mode)
            if denied:
                raise ApiError(*denied)
            handler, params = self.resolve(url.path)
            if (url.path not in LOCAL and not url.path.startswith("/webhook/")
                    and not re.fullmatch(r"/api/(?:schedule|webhooks|addons)(?:/[^/]+)?", url.path)):
                try:
                    self.transport = self.server.get_transport()
                except NotPairedError:
                    raise ApiError(503, NOT_PAIRED) from None
                except ConfigError as error:
                    raise ApiError(503, str(error)) from None
            self.query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            result = handler(self, params)
            if result is not None:
                status, body = result if isinstance(result, tuple) else (200, result)
                self.send_json(status, body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client left
        except ApiError as error:
            headers = {"WWW-Authenticate": "Bearer"} if error.status == 401 else {}
            self.send_json(error.status, {"error": str(error)}, headers)
        except TvBusyError as error:
            self.send_json(409, {"error": str(error).strip()})
        except (ConfigError, NotPairedError) as error:
            self.send_json(503, {"error": str(error).strip() or NOT_PAIRED})
        except ValueError as error:  # includes ValidationError and bad JSON
            self.send_json(400, {"error": str(error)})
        except (TransportError, WebosFoundryError, RuntimeError, OSError) as error:
            self.send_json(502, {"error": str(error).strip() or type(error).__name__})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "Internal server error; see the wof serve terminal"})

    def resolve(self, path):
        methods = []
        for item in ROUTES:
            match = item["regex"].match(path)
            if match:
                if item["method"] == self.command:
                    return item["handler"], match.groupdict()
                methods.append(item["method"])
        if methods:
            raise ApiError(405, "Use %s for %s" % (" or ".join(methods), path))
        raise ApiError(404, "No such endpoint; GET /api lists them")

    def length(self, limit):
        if "Transfer-Encoding" in self.headers:
            raise ApiError(411, "Send a Content-Length; chunked bodies are not accepted")
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "Invalid Content-Length") from None
        if not 0 <= size <= limit:
            raise ApiError(413, "Request body must be at most %d MiB" % (limit // 1048576) if limit >= 1048576
                           else "Request body is too large")
        return size

    def raw_body(self, limit):
        size = self.length(limit)
        if not size:
            raise ApiError(400, "Send the file as the request body")
        return self.rfile.read(size)

    def json_body(self, required=True):
        size = self.length(MAX_JSON)
        if not size:
            if required:
                raise ApiError(400, "Send a JSON body")
            return {}
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            raise ApiError(415, "Send the body as application/json")
        body = json.loads(self.rfile.read(size))
        if not isinstance(body, dict):
            raise ApiError(400, "The JSON body must be an object")
        return body

    def send_json(self, status, body, headers=None):
        self.send_bytes(status, json.dumps(body).encode(), "application/json", headers=headers)

    def send_static(self, path):
        match = UPLOAD_RE.fullmatch(path)
        target = (ROOT / "uploads" / (match.group(1) + ".ipk") if ROOT is not None else None) if match else static_file(path)
        if target is None or not target.is_file():
            raise ApiError(404, "Not found")
        self.send_bytes(200, target.read_bytes(), "application/octet-stream" if match else TYPES[target.suffix.lower()])

    def send_bytes(self, status, data, kind, filename=None, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        if filename:  # safe_stem and fixed profile names only
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.end_headers()
        self.wfile.write(data)


def stop_stream():
    STREAM_STOP.set()
    if STREAM_LOCK.acquire(timeout=30):  # the stream's handler thread stops the TV-side client first
        STREAM_LOCK.release()


def stop_jobs():
    with LOCK:
        job = active()
        if job and job.state == "running":
            job.state = "cancelling"
            job.cancel.set()
    if not job:
        return
    print("Stopping job %s and waiting for the TV to be restored..." % job.id, flush=True)
    if job.thread:
        job.thread.join(180)
    with LOCK:
        state, recovery, error = job.state, job.recovery, job.release_error
    print("Job %s: %s" % (job.id, state.replace("_", " ")), flush=True)
    if error:
        print("TV release unconfirmed (%s). Check the TV picture and sound settings." % error, flush=True)
    if recovery:
        print("Recovery workspace kept on the TV: " + recovery, flush=True)


class SchedulerThread(threading.Thread):
    def __init__(self, server):
        super().__init__(daemon=True)
        self.server = server
        self.stop = threading.Event()
        self.last_fired = {}

    def run(self):
        while not self.stop.is_set():
            try:
                now = datetime.now()
                minute = now.strftime("%Y-%m-%d %H:%M")
                self.last_fired = {key: value for key, value in self.last_fired.items() if value == minute}
                entries = schedule.load()
                for entry_id in schedule.due(entries, now):
                    if self.stop.is_set():
                        break
                    if self.last_fired.get(entry_id) == minute:
                        continue
                    self.last_fired[entry_id] = minute
                    try:
                        if not TV_LOCK.acquire(blocking=False):
                            print("Schedule %s skipped: the TV is busy" % entry_id, flush=True)
                            continue
                        try:
                            with LOCK:
                                job = active()
                                if job:
                                    print("Schedule %s skipped: processing job %s (%s)" %
                                          (entry_id, job.id, job.state.replace("_", " ")), flush=True)
                                    continue
                            name = entries[entry_id]["scene"]
                            saved = scenes.load()
                            if name not in saved:
                                raise ValueError("No such scene: %s" % name)
                            scenes.run_scene(self.server.get_transport(), saved[name])
                        finally:
                            TV_LOCK.release()
                    except Exception as error:
                        print("Schedule %s failed: %s" % (entry_id, error), flush=True)
            except Exception as error:
                print("Scheduler failed: %s" % error, flush=True)
            self.stop.wait(20)


class AddonsThread(threading.Thread):
    """Polls every enabled installed addon on its own interval and pushes the result to the TV --
    the always-on half of the addon framework (ARCHITECTURE.md section 12). Mirrors SchedulerThread's
    locking: a busy TV or an active processing job skips that tick, logged and retried next tick."""
    TICK = 10

    def __init__(self, server):
        super().__init__(daemon=True)
        self.server = server
        self.stop = threading.Event()
        self.last = {}

    def run(self):
        while not self.stop.wait(self.TICK):
            try:
                installed = addons.load()
            except Exception as error:
                print("Addons failed: %s" % error, flush=True)
                continue
            now = time.monotonic()
            for addon_id, entry in installed.items():
                if self.stop.is_set():
                    break
                if not entry.get("enabled") or now < self.last.get(addon_id, 0) + entry["interval_seconds"]:
                    continue
                self.last[addon_id] = now
                if not TV_LOCK.acquire(blocking=False):
                    print("Addon %s skipped: the TV is busy" % addon_id, flush=True)
                    continue
                try:
                    with LOCK:
                        job = active()
                        if job:
                            print("Addon %s skipped: processing job %s (%s)" %
                                  (addon_id, job.id, job.state.replace("_", " ")), flush=True)
                            continue
                    card = addons.card_for(addon_id, entry)
                    notify.overlay_show(self.server.get_transport(), card)
                except Exception as error:
                    print("Addon %s failed: %s" % (addon_id, error), flush=True)
                finally:
                    TV_LOCK.release()


def main(argv=None):
    parser = argparse.ArgumentParser(prog="wof serve", description="HTTP API and web UI for a rooted LG webOS TV")
    parser.add_argument("--host", "--bind", dest="host", default="127.0.0.1",
                        help="address to listen on (default 127.0.0.1; anything else requires a token)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", help="bearer token (default: server_token from the config)")
    parser.add_argument("--generate-token", action="store_true",
                        help="print a new random token and exit; save it as server_token or pass it with --token")
    args = parser.parse_args(argv)
    if args.generate_token:
        print(secrets.token_urlsafe(32))
        return 0
    token, auth_mode = args.token, "token"
    try:
        config = Config.load()
        token, auth_mode = token or config.server_token, config.auth_mode
    except (ConfigError, NotPairedError):
        pass
    if not is_loopback(args.host) and not token and auth_mode == "token":
        print("Refusing to listen on %s without a token: set server_token in the config or pass --token "
              "(wof serve --generate-token makes one)." % args.host, file=sys.stderr)
        return 2
    global ROOT
    server = FoundryServer((args.host, args.port), token=token, auth_mode=auth_mode)

    def interrupt(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    if paired_host() is None:
        print(NOT_PAIRED, flush=True)
    login = ("OFF - anyone who can reach this address controls the TV" if auth_mode == "disabled"
             else "required" if not server.loopback else "optional" if token else "off")
    print("webOS Foundry: http://%s:%d/  (token %s; Ctrl-C stops; a running job is cancelled and the TV restored first)"
          % (args.host, server.server_address[1], login), flush=True)
    scheduler = SchedulerThread(server)
    scheduler.start()
    addons_thread = AddonsThread(server)
    addons_thread.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scheduler.stop.set()
        scheduler.join(2)
        addons_thread.stop.set()
        addons_thread.join(2)
        server.server_close()
        stop_stream()
        stop_jobs()
        if ROOT is not None:
            shutil.rmtree(ROOT, ignore_errors=True)
            ROOT = None
    return 0


if __name__ == "__main__":
    sys.exit(main())
