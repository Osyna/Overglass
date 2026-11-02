"""On-screen toast, spoken announcement and overlay card (ports of tv-c5-notify.js validation)."""
import base64
import json
import re
from datetime import datetime

from . import dispatcher
from .errors import ValidationError

MAX_CHARS = 200
MAX_B64_TEXT = 400  # the dispatcher grammar's limit for toast/say payloads
MAX_TREE_BYTES = 49152  # pre-flight check (dispatch.sh's CARD_MAX, the hard stdin ceiling, is more generous at 65536)
KINDS = ("info", "success", "warning", "alert")
TONES = KINDS + ("accent",)  # widget tones: the four semantic kinds plus the theme's accent colour
POSITIONS = ("top-left", "top-right", "bottom-left", "bottom-right", "center", "top", "bottom", "left", "right")
SIZES = ("xs", "s", "m", "l", "xl", "full")
TEXT_SIZES = ("xs", "s", "m", "l", "xl")
WEIGHTS = ("normal", "strong")
COLORS = ("fg", "fg-2") + TONES
LIST_STYLES = ("bullet", "number", "plain")
WIDGET_TYPES = ("stack", "row", "text", "image", "badge", "dot", "progress", "countdown", "list", "divider",
                "compare", "sparkline", "section", "event", "stat", "status", "meta", "clock")
IMAGE_SHAPES = ("square", "circle")
IMAGE_SIZES = ("s", "m", "l")
ICONS = ("ball", "bolt", "chart", "trophy", "pulse", "layers", "clock", "pin", "sun", "card", "swap", "target",
         "info", "bell", "star", "flag")
STATES = ("online", "offline", "degraded", "unknown")
CLOCK_FORMATS = ("time", "seconds", "date")
FONTS = ("sans", "condensed", "mono")
THEME_COLORS = ("accent", "surface", "text", "muted", "line")
MAX_TREE_DEPTH = 5
MAX_TREE_NODES = 80  # across every region of one card
MAX_REGIONS = 4
SHORTHAND_FIELDS = ("title", "body", "lines", "image", "kind")
_CONTROL = re.compile("[\x00-\x1f\x7f]")
_URL = re.compile(r"https?://[^\s\"'<>]+")
_HEX = re.compile(r"#[0-9a-fA-F]{6}")


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


def _check_enum(value, choices, what):
    if value not in choices:
        raise ValidationError("%s must be one of %s" % (what, ", ".join(choices)))
    return value


def _check_int(value, lo, hi, what):
    if type(value) is not int or not lo <= value <= hi:
        raise ValidationError("%s must be an integer %d-%d" % (what, lo, hi))
    return value


def _check_node(node, depth, counter) -> dict:
    """Validate and normalise one widget tree node (ARCHITECTURE.md §3a), recursively. counter[0]
    tracks the total node count across the whole call so the cap applies to the tree, not one level."""
    counter[0] += 1
    if counter[0] > MAX_TREE_NODES:
        raise ValidationError("A card may have at most %d widgets" % MAX_TREE_NODES)
    if depth > MAX_TREE_DEPTH:
        raise ValidationError("A card may nest at most %d levels deep" % MAX_TREE_DEPTH)
    if not isinstance(node, dict):
        raise ValidationError("Each widget must be a JSON object")
    kind = node.get("type")
    if kind not in WIDGET_TYPES:
        raise ValidationError("Unknown widget type: %r" % (kind,))
    out = {"type": kind}
    if kind in ("stack", "row"):
        children = node.get("children")
        limit = 20 if kind == "stack" else 10
        if not isinstance(children, list) or not 1 <= len(children) <= limit:
            raise ValidationError("%s needs 1-%d children" % (kind, limit))
        if "gap" in node:
            out["gap"] = _check_int(node["gap"], 0, 48, "gap")
        if "align" in node:
            out["align"] = _check_enum(node["align"], ("start", "center", "end"), "align")
        out["children"] = [_check_node(child, depth + 1, counter) for child in children]
    elif kind == "text":
        out["text"] = _clean(node.get("text"), 400, "text")
        if "size" in node:
            out["size"] = _check_enum(node["size"], TEXT_SIZES, "size")
        if "weight" in node:
            out["weight"] = _check_enum(node["weight"], WEIGHTS, "weight")
        if "color" in node:
            out["color"] = _check_enum(node["color"], COLORS, "color")
    elif kind == "image":
        src = node.get("src")
        if not isinstance(src, str) or len(src) > 500 or not _URL.fullmatch(src):
            raise ValidationError("image src must be an http(s) URL of at most 500 characters")
        out["src"] = src
        if "shape" in node:
            out["shape"] = _check_enum(node["shape"], IMAGE_SHAPES, "shape")
        if "size" in node:
            out["size"] = _check_enum(node["size"], IMAGE_SIZES, "size")
    elif kind == "badge":
        out["text"] = _clean(node.get("text"), 24, "badge text")
        _optional_tone(node, out)
    elif kind == "dot":
        _optional_tone(node, out)
    elif kind == "progress":
        out["value"] = _check_fraction(node.get("value"), "progress value")
        if "label" in node:
            out["label"] = _clean(node["label"], 40, "label")
        _optional_tone(node, out)
    elif kind == "countdown":
        target = node.get("target")
        if not isinstance(target, str):
            raise ValidationError("countdown target must be an ISO 8601 datetime string")
        try:
            datetime.fromisoformat(target.replace("Z", "+00:00"))
        except ValueError:
            raise ValidationError("countdown target must be an ISO 8601 datetime string") from None
        out["target"] = target
        if "label" in node:
            out["label"] = _clean(node["label"], 40, "label")
    elif kind == "list":
        items = node.get("items")
        if not isinstance(items, list) or not 1 <= len(items) <= 10:
            raise ValidationError("list needs 1-10 items")
        out["items"] = [_clean(item, 120, "Each item") for item in items]
        if "style" in node:
            out["style"] = _check_enum(node["style"], LIST_STYLES, "style")
    elif kind == "compare":
        segments = node.get("segments")
        if not isinstance(segments, list) or not 2 <= len(segments) <= 4:
            raise ValidationError("compare needs 2-4 segments")
        out["segments"] = [_check_segment(segment) for segment in segments]
    elif kind == "sparkline":
        points = node.get("points")
        if not isinstance(points, list) or not 3 <= len(points) <= 24:
            raise ValidationError("sparkline needs 3-24 points")
        if not all(type(point) in (int, float) and not isinstance(point, bool) and -1 <= point <= 1
                   for point in points):
            raise ValidationError("sparkline points must be numbers between -1 and 1")
        out["points"] = [float(point) for point in points]
        if "axis" in node:
            axis = node["axis"]
            if not isinstance(axis, list) or len(axis) != 3:
                raise ValidationError("sparkline axis must be three labels: top, middle, bottom")
            out["axis"] = [_clean(label, 6, "axis label") for label in axis]
        _optional_tone(node, out)
    elif kind == "section":
        out["title"] = _clean(node.get("title"), 40, "section title")
        if "icon" in node:
            out["icon"] = _check_enum(node["icon"], ICONS, "icon")
        if "action" in node:
            out["action"] = _clean(node["action"], 24, "section action")
    elif kind == "event":
        out["time"] = _clean(node.get("time"), 8, "event time")
        out["text"] = _clean(node.get("text"), 120, "event text")
        if "icon" in node:
            out["icon"] = _check_enum(node["icon"], ICONS, "icon")
        _optional_tone(node, out)
    elif kind == "stat":
        out["label"] = _clean(node.get("label"), 40, "stat label")
        out["left"] = _clean(node.get("left"), 16, "stat left value")
        out["right"] = _clean(node.get("right"), 16, "stat right value")
        out["fraction"] = _check_fraction(node.get("fraction"), "stat fraction")
        _optional_tone(node, out)
    elif kind == "status":
        out["label"] = _clean(node.get("label"), 40, "status label")
        out["state"] = _check_enum(node.get("state"), STATES, "status state")
        if "detail" in node:
            out["detail"] = _clean(node["detail"], 24, "status detail")
    elif kind == "meta":
        items = node.get("items")
        if not isinstance(items, list) or not 1 <= len(items) <= 4:
            raise ValidationError("meta needs 1-4 items")
        out["items"] = [_check_meta_item(item) for item in items]
    elif kind == "clock":
        if "format" in node:
            out["format"] = _check_enum(node["format"], CLOCK_FORMATS, "clock format")
        if "label" in node:
            out["label"] = _clean(node["label"], 40, "label")
    # divider has no fields
    return out


def _optional_tone(node, out):
    if "tone" in node:
        out["tone"] = _check_enum(node["tone"], TONES, "tone")


def _check_fraction(value, what):
    if type(value) not in (int, float) or isinstance(value, bool) or not 0 <= value <= 1:
        raise ValidationError("%s must be a number 0-1" % what)
    return float(value)


def _check_segment(segment):
    if not isinstance(segment, dict):
        raise ValidationError("Each compare segment must be a JSON object")
    out = {"label": _clean(segment.get("label"), 24, "segment label"),
           "value": _clean(segment.get("value"), 16, "segment value"),
           "fraction": _check_fraction(segment.get("fraction"), "segment fraction")}
    _optional_tone(segment, out)
    return out


def _check_meta_item(item):
    if not isinstance(item, dict):
        raise ValidationError("Each meta item must be a JSON object")
    out = {"label": _clean(item.get("label"), 24, "meta label"), "value": _clean(item.get("value"), 40, "meta value")}
    if "icon" in item:
        out["icon"] = _check_enum(item["icon"], ICONS, "icon")
    return out


def _check_theme(theme):
    """Card colours and typography: hex colours only, bounded numbers, nothing the TV could misread."""
    if not isinstance(theme, dict):
        raise ValidationError("theme must be a JSON object")
    out = {}
    for key, value in theme.items():
        if key in THEME_COLORS:
            if not isinstance(value, str) or not _HEX.fullmatch(value):
                raise ValidationError("theme %s must be a #rrggbb colour" % key)
            out[key] = value.lower()
        elif key == "opacity":
            if type(value) not in (int, float) or isinstance(value, bool) or not 0.2 <= value <= 1:
                raise ValidationError("theme opacity must be a number 0.2-1")
            out[key] = float(value)
        elif key == "radius":
            out[key] = _check_int(value, 0, 32, "theme radius")
        elif key == "scale":
            if type(value) not in (int, float) or isinstance(value, bool) or not 0.75 <= value <= 1.5:
                raise ValidationError("theme scale must be a number 0.75-1.5")
            out[key] = float(value)
        elif key == "font":
            out[key] = _check_enum(value, FONTS, "theme font")
        else:
            raise ValidationError("Unknown theme field: %s" % key)
    return out


def _clean_shorthand(card) -> dict:
    """The original five flat card fields, validated exactly as the pre-tree check_card() did."""
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
    if "kind" in card:
        out["kind"] = _check_enum(card["kind"], KINDS, "kind")
    if not out.get("title") and not out.get("body") and not out.get("lines") and not out.get("image"):
        raise ValidationError("An overlay card needs a title, body, lines, image or a root widget tree")
    return out


def _compile_card(card) -> dict:
    """The flat shorthand fields -> an equivalent widget tree, so every existing caller (the web UI's
    basic card form, the Home Assistant overlay_show service, wof overlay) keeps working unchanged;
    the TV-side renderer only ever sees a tree, never the flat shape."""
    head = []
    if card.get("title") or "kind" in card:
        row = [{"type": "dot", "tone": card.get("kind", "info")}]
        if card.get("title"):
            row.append({"type": "text", "text": card["title"], "size": "l", "weight": "strong"})
        head.append({"type": "row", "gap": 14, "align": "center", "children": row})
    body = []
    if card.get("body"):
        body.append({"type": "text", "text": card["body"], "color": "fg-2"})
    if card.get("lines"):
        body.append({"type": "list", "items": card["lines"]})
    if card.get("image"):
        body.append({"type": "image", "src": card["image"]})
    return {"type": "stack", "gap": 12, "children": head + body}


def check_overlay_request(body) -> dict:
    """Validate a POST /api/overlay body. Either {"hide": true} alone, or a card: {"position"?,
    "size"?, "seconds"?, "theme"?, "root": <widget tree>} for the general case, {"seconds"?, "theme"?,
    "regions": [{"position", "size"?, "root"}, ...]} for a multi-region layout (a top bar plus a side
    panel, say -- several cards in the one overlay window, since only one such window can ever be
    visible), or the shorthand {"title"?, "body"?, "lines"?, "image"?, "kind"?, "position"?, "size"?,
    "seconds"?} which is compiled into an equivalent tree right here (see _compile_card) -- the
    dispatcher and the TV only ever see trees."""
    if not isinstance(body, dict):
        raise ValidationError("The card must be a JSON object")
    if body.get("hide") is True:
        if len(body) != 1:
            raise ValidationError('Use {"hide": true} alone to hide the overlay')
        return {"hide": True}
    out = {}
    if "seconds" in body:
        out["seconds"] = _check_int(body["seconds"], 0, 300, "seconds")
    if "theme" in body:
        out["theme"] = _check_theme(body["theme"])
    counter = [0]
    if "regions" in body:
        unknown = [key for key in body if key not in ("seconds", "theme", "regions")]
        if unknown:
            raise ValidationError("Unknown overlay field: " + ", ".join(map(str, unknown)))
        regions = body["regions"]
        if not isinstance(regions, list) or not 1 <= len(regions) <= MAX_REGIONS:
            raise ValidationError("regions needs 1-%d entries" % MAX_REGIONS)
        out["regions"], seen = [], set()
        for region in regions:
            if not isinstance(region, dict) or set(region) - {"position", "size", "root"} or "root" not in region:
                raise ValidationError("Each region is {\"position\", \"size\"?, \"root\"}")
            checked = {"position": _check_enum(region.get("position"), POSITIONS, "region position")}
            if checked["position"] in seen:
                raise ValidationError("Each region needs a different position")
            seen.add(checked["position"])
            if "size" in region:
                checked["size"] = _check_enum(region["size"], SIZES, "size")
            checked["root"] = _check_node(region["root"], 0, counter)
            out["regions"].append(checked)
    else:
        if "position" in body:
            out["position"] = _check_enum(body["position"], POSITIONS, "position")
        if "size" in body:
            out["size"] = _check_enum(body["size"], SIZES, "size")
        extras = ("position", "size", "seconds", "theme")
        if "root" in body:
            unknown = [key for key in body if key not in extras + ("root",)]
            if unknown:
                raise ValidationError("Unknown overlay field: " + ", ".join(map(str, unknown)))
            out["root"] = _check_node(body["root"], 0, counter)
        else:
            unknown = [key for key in body if key not in extras + SHORTHAND_FIELDS]
            if unknown:
                raise ValidationError("Unknown overlay field: " + ", ".join(map(str, unknown)))
            card = {key: body[key] for key in SHORTHAND_FIELDS if key in body}
            out["root"] = _check_node(_compile_card(_clean_shorthand(card)), 0, counter)
    encoded = json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > MAX_TREE_BYTES:
        raise ValidationError("Card is too large (at most %d bytes of JSON)" % MAX_TREE_BYTES)
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
    payload = json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode()
    reply = _reply(transport.run(dispatcher.build_notify_overlay(), data=payload, timeout=30))
    return "Overlay card " + str(reply.get("overlay"))


def overlay_show(transport, body) -> str:
    """Show a card on the TV; see check_overlay_request for the accepted shapes. The TV script
    validates the tree again and refuses a TV that is not on."""
    return _send_card(transport, check_overlay_request(body))


def overlay_hide(transport) -> str:
    return _send_card(transport, {"hide": True})
