"""On-screen toast, spoken announcement and overlay card (ports of tv-c5-notify.js validation)."""
import base64
import json
import re

from . import dispatcher
from .errors import ValidationError

MAX_CHARS = 200
MAX_B64_TEXT = 400  # the dispatcher grammar's limit for toast/say payloads
MAX_B64_CARD = 6000  # notify.js refuses more, although the grammar admits 8000
KINDS = ("info", "success", "warning", "alert")
POSITIONS = ("top-left", "top-right", "bottom-left", "bottom-right", "center")
CARD_FIELDS = ("title", "body", "lines", "image", "kind", "position", "seconds", "hide")
_CONTROL = re.compile("[\x00-\x1f\x7f]")
_URL = re.compile(r"https?://[^\s\"'<>]+")


def _b64(text):
    try:
        return base64.b64encode(text.encode()).decode()  # lone surrogates raise UnicodeEncodeError (a ValueError)
    except UnicodeEncodeError:
        raise ValidationError("Text must be valid Unicode") from None


def _text_payload(text):
    if not isinstance(text, str):
        raise ValidationError("Message must be text")
    text = text.strip()
    if not 1 <= len(text) <= MAX_CHARS or _CONTROL.search(text):
        raise ValidationError("Message must be 1-%d characters without control characters" % MAX_CHARS)
    encoded = _b64(text)
    if len(encoded) > MAX_B64_TEXT:
        raise ValidationError("Message is too long to send (at most about 300 bytes of UTF-8)")
    return encoded


def _check_volume(volume):
    if type(volume) is not int or not 1 <= volume <= 40:
        raise ValidationError("Volume must be an integer 1-40")


def _clean(value, maximum, what):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValidationError("%s must be text of at most %d characters" % (what, maximum))
    if _CONTROL.search(value):
        raise ValidationError("%s must not contain control characters" % what)
    return value.strip()


def check_card(card) -> dict:
    """Validate and normalise an overlay card exactly as notify.js card() does; returns the cleaned card."""
    if not isinstance(card, dict):
        raise ValidationError("The card must be a JSON object")
    extra = [key for key in card if key not in CARD_FIELDS]
    if extra:
        raise ValidationError("Unknown overlay field: " + ", ".join(map(str, extra)))
    if "hide" in card:
        if card["hide"] is not True or len(card) != 1:
            raise ValidationError('Use {"hide": true} alone to hide the overlay')
        return {"hide": True}
    out = {}
    if "title" in card:
        out["title"] = _clean(card["title"], 80, "title")
    if "body" in card:
        out["body"] = _clean(card["body"], 400, "body")
    if "lines" in card:
        lines = card["lines"]
        if not isinstance(lines, list) or len(lines) > 10:
            raise ValidationError("lines must be a list of at most 10 texts")
        out["lines"] = [_clean(line, 120, "Each line") for line in lines]
    if "image" in card:
        image = card["image"]
        if not isinstance(image, str) or len(image) > 500 or not _URL.fullmatch(image):
            raise ValidationError("image must be an http(s) URL of at most 500 characters")
        out["image"] = image
    for key, values in (("kind", KINDS), ("position", POSITIONS)):
        if key in card:
            if card[key] not in values:
                raise ValidationError("%s must be one of %s" % (key, ", ".join(values)))
            out[key] = card[key]
    if "seconds" in card:
        seconds = card["seconds"]
        if type(seconds) is not int or not 0 <= seconds <= 300:
            raise ValidationError("seconds must be an integer 0-300")
        out["seconds"] = seconds
    if not out.get("title") and not out.get("body") and not out.get("lines") and not out.get("image"):
        raise ValidationError("An overlay card needs a title, body, lines or image")
    return out


def _reply(out):
    text = out.decode(errors="replace") if isinstance(out, bytes) else out
    try:
        reply = json.loads(text.strip().splitlines()[-1])
    except (ValueError, IndexError):
        reply = None
    if not isinstance(reply, dict) or reply.get("returnValue") is not True:
        raise RuntimeError("TV returned a malformed reply: " + text[-200:])
    return reply


def toast(transport, text) -> str:
    """On-screen toast. Returns a message string."""
    _reply(transport.run(dispatcher.build_notify_toast(_text_payload(text)), timeout=20))
    return "Toast shown on the TV"


def say(transport, text, volume=15) -> str:
    """Spoken announcement through the TV speaker. The TV runs it under its lock, since it borrows Audio
    Guidance, volume and mute and restores all three."""
    encoded = _text_payload(text)
    _check_volume(volume)
    reply = _reply(transport.run(dispatcher.build_notify_say(encoded, volume), timeout=60))
    return "Spoke %s characters at volume %s; the TV's volume, mute and Audio Guidance are restored" % (
        reply.get("spoke"), reply.get("volume"))


def _send_card(transport, card):
    encoded = _b64(json.dumps(card, ensure_ascii=False, separators=(",", ":")))
    if len(encoded) > MAX_B64_CARD:
        raise ValidationError("The card is too large")
    reply = _reply(transport.run(dispatcher.build_notify_overlay(encoded), timeout=30))
    return "Overlay card " + str(reply.get("overlay"))


def overlay_show(transport, card) -> str:
    """Show a card on the TV ({"hide": true} hides it). The TV script validates every field again and
    refuses a TV that is not on."""
    return _send_card(transport, check_card(card))


def overlay_hide(transport) -> str:
    return _send_card(transport, {"hide": True})
