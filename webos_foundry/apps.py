"""Homebrew app management on the TV: list, install from a URL, uninstall (ARCHITECTURE.md §10.2)."""
import base64
import json
import re

from . import dispatcher
from .errors import ValidationError

URL_RE = re.compile(r"https?://[^\s\"'\\`<>]+")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")
MAX_URL = 500
INSTALL_TIMEOUT = 100  # the TV script gives up after 90 s


def _b64(data):
    return base64.b64encode(data).decode()


def _reply(out, what):
    text = out.decode(errors="replace") if isinstance(out, bytes) else out
    try:
        doc = json.loads(text.strip().splitlines()[-1] if text.strip() else "")
    except ValueError:
        raise RuntimeError("TV returned a malformed %s reply: %s" % (what, text[-200:])) from None
    if not isinstance(doc, dict) or doc.get("returnValue") is not True:
        raise RuntimeError("TV refused the %s: %s" % (what, text.strip()[-200:]))
    return doc


def list_apps(transport) -> list:
    """Removable apps (system apps are not removable): [{id, title, icon, version, removable}]."""
    text = transport.run(dispatcher.build_app_list(), timeout=20).decode(errors="replace")
    try:
        items = json.loads(text)
    except ValueError:
        items = None
    if not isinstance(items, list) or not all(isinstance(i, dict) and isinstance(i.get("id"), str) for i in items):
        raise RuntimeError("TV returned a malformed app list: " + text[-200:])
    return items


def install_app(transport, url, sha256=None) -> str:
    """The TV downloads `url` itself and installs it. Without `sha256` the download is not verified."""
    if not isinstance(url, str) or len(url) > MAX_URL or not URL_RE.fullmatch(url):
        raise ValidationError("The IPK address must be an http(s) URL of at most %d characters" % MAX_URL)
    request = {"url": url}
    if sha256 is not None:
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            raise ValidationError("sha256 must be 64 lowercase hex characters")
        request["sha256"] = sha256
    payload = _b64(json.dumps(request, separators=(",", ":")).encode())
    _reply(transport.run(dispatcher.build_app_install(payload), timeout=INSTALL_TIMEOUT), "install")
    return "App installed"


def uninstall_app(transport, app_id) -> str:
    if not isinstance(app_id, str) or not ID_RE.fullmatch(app_id):
        raise ValidationError("Invalid app id")
    _reply(transport.run(dispatcher.build_app_uninstall(_b64(app_id.encode())), timeout=INSTALL_TIMEOUT), "uninstall")
    return "App removed"
