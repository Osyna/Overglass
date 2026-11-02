"""Scalar-only data bindings and capability payloads for saved overlay designs."""
import copy
import math
import re
from urllib.parse import urlsplit

from . import datafetch, notify
from .errors import ValidationError

_FIELDS = {
    "text": ("text",), "badge": ("text",), "ticker": ("text",),
    "progress": ("value", "label"), "countdown": ("target", "label"),
    "section": ("title", "action"), "event": ("time", "text"),
    "stat": ("label", "left", "right", "fraction"), "status": ("label", "state", "detail"),
    "clock": ("label",), "image": ("alt",),
}
_VARIABLE = re.compile(r"\{\{([A-Za-z_][A-Za-z0-9_]{0,59})\}\}")
_FORBIDDEN = {"__proto__", "prototype", "constructor"}
_DECIMAL = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")


def scalar(value):
    if value is None or type(value) not in (str, int, float, bool) or (type(value) is float and not math.isfinite(value)):
        raise ValidationError("A binding value must be a finite text, number or boolean scalar")
    return value


def targets(card):
    """Return only existing display-value pointers, never structure, styles or URLs."""
    found = {}

    def node(widget, prefix):
        for key in _FIELDS.get(widget["type"], ()):
            if key in widget:
                found[prefix + "/" + key] = widget[key]
        for index, child in enumerate(widget.get("children", ())):
            node(child, prefix + "/children/" + str(index))
        kind = widget["type"]
        if kind == "list":
            for index, item in enumerate(widget["items"]):
                found[prefix + "/items/" + str(index)] = item
        if kind == "sparkline":
            for index, point in enumerate(widget["points"]):
                found[prefix + "/points/" + str(index)] = point
        if kind in ("compare", "meta"):
            key = "segments" if kind == "compare" else "items"
            for index, item in enumerate(widget[key]):
                for field in ("label", "value", "fraction"):
                    if field in item:
                        found[prefix + "/" + key + "/" + str(index) + "/" + field] = item[field]

    def visit(current, prefix=""):
        if "timeline" in current:
            for index, frame in enumerate(current["timeline"]):
                visit(frame["card"], prefix + "/timeline/" + str(index) + "/card")
        elif "regions" in current:
            for index, region in enumerate(current["regions"]):
                node(region["root"], prefix + "/regions/" + str(index) + "/root")
        else:
            node(current["root"], prefix + "/root")

    visit(card)
    return found


def check(card, entries):
    if not isinstance(entries, list) or len(entries) > 20:
        raise ValidationError("bindings must be a list of at most 20 entries")
    allowed, used, checked = targets(card), set(), []
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) - {"target", "source", "fallback"}:
            raise ValidationError("A binding takes target, source and optional fallback")
        target, source = entry.get("target"), entry.get("source")
        if not isinstance(target, str) or target not in allowed or target in used:
            raise ValidationError("A binding target must be a unique existing display-value JSON pointer")
        if not isinstance(source, dict) or set(source) - {"kind", "url", "path", "token", "allow_private", "required_secrets"}:
            raise ValidationError("Invalid binding source fields")
        if source.get("kind") not in ("json", "homeassistant"):
            raise ValidationError("Binding source kind must be json or homeassistant")
        url = source.get("url")
        try:
            parsed = urlsplit(url) if isinstance(url, str) else None
            valid = parsed and parsed.scheme in ("http", "https") and parsed.hostname and not parsed.username and not parsed.password and parsed.port != 0
        except ValueError:
            valid = False
        if not valid or len(url) > 2048 or any(ord(char) < 33 for char in url) or parsed.fragment:
            raise ValidationError("Binding URL must be HTTP(S), without credentials or a fragment")
        path = source.get("path", "")
        if not isinstance(path, str) or len(path) > 500 or any(part in _FORBIDDEN for part in re.split(r"[./]", path)):
            raise ValidationError("Invalid binding source path")
        if "allow_private" in source and type(source["allow_private"]) is not bool:
            raise ValidationError("Binding allow_private must be a boolean")
        missing = source.get("required_secrets", [])
        if not isinstance(missing, list) or any(item not in ("token", "url") for item in missing):
            raise ValidationError("Invalid required_secrets marker")
        token = source.get("token")
        if "token" in source and (not isinstance(token, str) or not token or len(token) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in token)):
            raise ValidationError("Binding token must be non-empty text without control characters")
        if source["kind"] == "homeassistant" and not token and "token" not in missing:
            raise ValidationError("A Home Assistant binding requires a token")
        normalized = {"kind": source["kind"], "url": url, "path": path}
        normalized.update({key: copy.deepcopy(source[key]) for key in ("token", "allow_private", "required_secrets") if key in source})
        out = {"target": target, "source": normalized}
        if "fallback" in entry:
            out["fallback"] = scalar(entry["fallback"])
            candidate = copy.deepcopy(card)
            _set(candidate, target, out["fallback"])
            notify.check_overlay_request(candidate)
        checked.append(out)
        used.add(target)
    return checked


def _set(card, pointer, value):
    parts = pointer[1:].split("/")
    parent = card
    for part in parts[:-1]:
        parent = parent[int(part)] if isinstance(parent, list) else parent[part]
    key = int(parts[-1]) if isinstance(parent, list) else parts[-1]
    old = parent[key]
    value = scalar(value)
    if isinstance(old, str):
        value = str(value).lower() if isinstance(value, bool) else str(value)
    elif type(old) in (int, float) and isinstance(value, str):
        if not _DECIMAL.fullmatch(value):
            raise ValidationError("Numeric binding targets require a finite decimal number")
        value = scalar(float(value))
    parent[key] = value


def resolve(body):
    from .designs import check_design
    design = check_design(body)
    entries = design.pop("bindings", [])
    for entry in entries:
        source = entry["source"]
        try:
            if source.get("required_secrets"):
                raise ValidationError("Binding requires secret values: " + ", ".join(source["required_secrets"]))
            headers = {"Authorization": "Bearer " + source["token"]} if source.get("token") else None
            document = datafetch.fetch_json(source["url"], headers=headers, allow_private=source.get("allow_private", False))
            value = scalar(datafetch.scalar_at(document, source["path"]))
        except (ValidationError, RuntimeError, OSError, ValueError) as error:
            if "fallback" not in entry:
                raise ValidationError("Binding could not resolve at " + entry["target"]) from error
            value = entry["fallback"]
        _set(design, entry["target"], value)
    return notify.check_overlay_request(design)


def apply_values(body, values):
    from .designs import check_design
    design = check_design(body)
    if not isinstance(values, dict) or len(values) > 40 or any(not isinstance(key, str) or key in _FORBIDDEN for key in values):
        raise ValidationError("Webhook values must be a scalar object of at most 40 keys")
    for value in values.values():
        scalar(value)
    allowed = {entry["target"] for entry in design.get("bindings", [])}
    display = targets(design)
    variables = {match.group(1) for value in display.values() if isinstance(value, str) for match in _VARIABLE.finditer(value)}
    if any(key not in allowed and key not in variables for key in values):
        raise ValidationError("Webhook values may only set binding targets or existing placeholder variables")
    overridden = allowed.intersection(values)
    if "bindings" in design:
        design["bindings"] = [entry for entry in design["bindings"] if entry["target"] not in overridden]
    for pointer, old in display.items():
        if pointer in overridden:
            _set(design, pointer, values[pointer])
        elif isinstance(old, str):
            _set(design, pointer, _VARIABLE.sub(lambda match: str(values[match.group(1)]) if match.group(1) in values else match.group(0), old))
    return resolve(design)
