"""Truthful status, read-only sensors, AI/sound settings and the finite remote (ports of c5_tv.py)."""
import base64
import json
import re
import socket
from pathlib import PurePosixPath

from . import dispatcher
from .config import Config
from .errors import NotPairedError, ValidationError

REMOTE_ACTIONS = dispatcher.REMOTE_ACTIONS
MARK = "@@@"
# Only these settings can ever be read or written: (category, key, label).
SETTINGS = (
    ("aiPicture", "ai_Picture", "AI Picture Pro"),
    ("aiPicture", "ai_Brightness", "AI Brightness"),
    ("aiPicture", "ai_Genre", "AI Genre"),
    ("picture", "superResolution", "Super Resolution"),
    ("sound", "soundMode", "Sound Mode"),
    ("sound", "aiSound", "AI Sound"),
    ("sound", "clearVoice", "Clear Voice"),
    ("sound", "aigamesound", "AI Game Sound"),
)
LABELS = {(category, key): label for category, key, label in SETTINGS}
DETAIL_TYPES = {"lux": int, "panel_hours": int, "panel_temperature_c": int, "pixel_refresher": dict,
                "power_on_reason": str, "power_history": list, "signal": dict, "sleep_timer": str, "usage_today": list}
DEFAULT_BROADCAST = "255.255.255.255:9"
MAC_RE = re.compile(r"[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}")


def _parse_documents(raw):
    decoder = json.JSONDecoder()
    documents = []
    while raw.strip():
        raw = raw.lstrip()
        document, end = decoder.raw_decode(raw)
        documents.append(document)
        raw = raw[end:]
    return documents


def _parse_power_docs(raw):
    """Port of ha-tv-poll.py status(): power, foreground app, Home manifest and temperature documents."""
    documents = _parse_documents(raw)
    if len(documents) != 4:
        raise ValueError("Expected power, foreground, Home manifest, and temperature")
    power, foreground, home, thermal = documents
    if not isinstance(power, dict) or power.get("returnValue") is not True or not isinstance(power.get("state"), str):
        raise ValueError("Power state unavailable")
    raw_power = power["state"]
    state = "on" if raw_power in ("Active", "Screen Saver") else "off" if raw_power == "Active Standby" else "unknown"
    app_id, source, is_luma = None, None, None
    if state == "off":
        source, is_luma = "Off", False
    elif state == "on":
        if not isinstance(foreground, dict) or foreground.get("returnValue") is not True \
                or not isinstance(foreground.get("appId"), str):
            raise ValueError("Foreground app unavailable")
        app_id = foreground["appId"] or None
        if app_id:
            home_main = home.get("main", "") if isinstance(home, dict) else ""
            is_luma = app_id == "com.ecklf.luma" or (
                app_id == "com.webos.app.home" and PurePosixPath(str(home_main)).name == "luma")
            prefix = "com.webos.app.hdmi"
            if is_luma:
                source = "Luma"
            elif app_id == "com.webos.app.home":
                source = "LG Home"
            elif app_id.startswith(prefix) and app_id[len(prefix):] in ("1", "2", "3", "4"):
                source = "HDMI " + app_id[len(prefix):]
            else:
                source = app_id
    # Temperature is independent: any bad reading hides only the temperature.
    if not isinstance(thermal, dict):
        thermal = {}
    millicelsius, temp_source = thermal.get("temperature_millicelsius"), thermal.get("temperature_source")
    valid = (isinstance(millicelsius, (int, float)) and not isinstance(millicelsius, bool)
             and 1000 <= millicelsius <= 149000 and isinstance(temp_source, str) and temp_source)
    return {"power": state, "raw_power_state": raw_power, "app_id": app_id, "source": source, "is_luma": is_luma,
            "temperature_c": millicelsius / 1000 if valid else None,
            "temperature_source": temp_source if valid else None}


def _volume(doc):
    status = doc.get("volumeStatus") if isinstance(doc, dict) and doc.get("returnValue") is True else None
    if (isinstance(status, dict) and type(status.get("volume")) is int and type(status.get("maxVolume")) is int
            and 0 <= status["volume"] <= status["maxVolume"] and type(status.get("muteStatus")) is bool):
        return status["volume"], status["muteStatus"]
    return None, None


def parse_status(raw):
    """Status docs (power, foreground, Home manifest, temperature), MARK, then audio getVolume."""
    docs, _, volume_raw = raw.partition(MARK)
    # Some firmware reports power states without spaces; the parser expects spaced names.
    status = _parse_power_docs(docs.replace('"ScreenSaver"', '"Screen Saver"').replace('"ActiveStandby"', '"Active Standby"'))
    try:
        volume, muted = _volume(json.loads(volume_raw))
    except ValueError:
        volume, muted = None, None
    if volume is None and status["power"] != "off":
        raise ValueError("Volume status unavailable")  # never show a guess while the TV is on
    # Standby: volume/muted are None because the audio service does not report them.
    return {**status, "volume": volume, "muted": muted}


def get_status(transport) -> dict:
    return parse_status(transport.run(dispatcher.build_status(), timeout=12).decode(errors="replace"))


def _json(out, what):
    text = out.decode(errors="replace") if isinstance(out, bytes) else out
    try:
        return json.loads(text)
    except ValueError:
        raise RuntimeError("TV returned malformed %s: %s" % (what, text[-200:])) from None


def parse_details(out):
    doc = _json(out, "details")
    if not isinstance(doc, dict) or any(
            key not in doc or (doc[key] is not None and type(doc[key]) is not kind) for key, kind in DETAIL_TYPES.items()):
        text = out.decode(errors="replace") if isinstance(out, bytes) else out
        raise RuntimeError("TV returned malformed details: " + text[-200:])
    return {key: doc[key] for key in DETAIL_TYPES}


def get_details(transport) -> dict:
    """Read-only: lux, OLED hours/temperature, pixel refresher, power history, signal, sleep timer, usage.
    Each field is None when the TV's service did not answer."""
    return parse_details(transport.run(dispatcher.build_details(), timeout=20))


def _item(raw):
    key = (raw.get("category"), raw.get("key")) if isinstance(raw, dict) else None
    values = raw.get("values") if key else None
    if (key not in LABELS or not isinstance(raw.get("value"), str) or not isinstance(values, list)
            or not all(isinstance(v, str) for v in values) or type(raw.get("available")) is not bool
            or not isinstance(raw.get("context"), dict)):
        raise RuntimeError("TV returned a malformed setting: " + json.dumps(raw, default=str)[:200])
    return {**raw, "label": LABELS[key]}


def get_settings(transport) -> list:
    """Allowed values/availability come from the TV for its current input/mode (item['context'])."""
    items = _json(transport.run(dispatcher.build_settings_list(), timeout=45), "settings list")
    if not isinstance(items, list):
        raise RuntimeError("TV returned a malformed settings list")
    order = {(c, k): i for i, (c, k, _) in enumerate(SETTINGS)}
    return sorted((_item(i) for i in items), key=lambda i: order[(i["category"], i["key"])])


def _check_setting(category, key, value, context):
    if (category, key) not in LABELS:
        raise ValidationError("Unsupported setting")
    if not isinstance(value, str) or not value:
        raise ValidationError("Setting value must be a non-empty string")
    if not isinstance(context, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in context.items()):
        raise ValidationError("Setting context must be the context dict returned by get_settings")


def _message(out, what):
    reply = _json(out, what)
    if isinstance(reply, dict):
        reply = reply.get("message")
    if not isinstance(reply, str):
        raise RuntimeError("TV returned a malformed reply")
    return reply


def set_setting(transport, category, key, value, context) -> str:
    """Returns a message string. Context, availability and allowed values are rechecked on the TV."""
    _check_setting(category, key, value, context)
    payload = base64.b64encode(json.dumps({"value": value, "context": context},
                                          separators=(",", ":")).encode()).decode()
    if len(payload) > 4000:
        raise ValidationError("The setting value and context are too large")
    reply = _json(transport.run(dispatcher.build_settings_set(category, key, payload), timeout=45), "reply")
    prefixed = isinstance(reply, dict)  # {"message": ...} arrives label-prefixed; a bare string does not
    text = reply.get("message") if prefixed else reply
    if not isinstance(text, str):
        raise RuntimeError("TV returned a malformed reply")
    return text if prefixed else LABELS[(category, key)] + ": " + text


def _check_remote(action, value):
    # Same rules as the dispatcher; checking here keeps wake (which never reaches the dispatcher) validated too.
    if action not in REMOTE_ACTIONS:
        raise ValidationError("Unknown remote action")
    if action == "hdmi":
        if type(value) is not int or not 1 <= value <= 4:
            raise ValidationError("HDMI input must be the integer 1-4")
    elif value is not None:
        raise ValidationError("This remote action takes no value")


def magic_packet(mac):
    if not isinstance(mac, str) or not MAC_RE.fullmatch(mac):
        raise ValidationError("The configured MAC address is invalid")
    return bytes.fromhex("FF" * 6 + re.sub("[:-]", "", mac) * 16)


def _broadcast_address(spec):
    host, _, port = (spec or DEFAULT_BROADCAST).rpartition(":")
    if not host or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValidationError("broadcast must look like 192.168.1.255:9")
    return host, int(port)


def _send_udp(packet, address):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        udp.sendto(packet, address)


def remote(transport, action, value=None, *, config=None) -> str:
    """Returns a message string. 'wake' only sends a UDP magic packet (config.mac) and never touches the
    transport: poll get_status() to confirm power."""
    _check_remote(action, value)
    if action == "wake":
        config = config or Config.require()
        if not config.mac:
            raise NotPairedError("No MAC address configured; run `wof config set mac AA:BB:CC:DD:EE:FF` first")
        _send_udp(magic_packet(config.mac), _broadcast_address(config.broadcast))
        return "Wake packet sent; the TV is not confirmed on yet"
    return _message(transport.run(dispatcher.build_remote(action, value), timeout=45), "reply")
