"""Small shared validators and bounded display helpers for source connectors."""
import json
import math
import re

from .. import notify
from ..errors import ValidationError

PRIVATE = {"key": "allow_private", "label": "Allow private network access", "type": "boolean", "default": False,
           "description": "Explicitly allow LAN/loopback destinations, including redirects. Enable only for trusted sources."}
URL = {"key": "url", "label": "Source URL", "type": "string", "required": True}
LABEL = {"key": "label", "label": "Card title", "type": "string"}
LIMIT = {"key": "limit", "label": "Maximum items", "type": "number", "default": 5, "min": 1, "max": 10, "step": 1}


def parameters(params):
    if not isinstance(params, dict):
        raise ValidationError("Connector parameters must be an object")
    return params


def private(params):
    value = params.get("allow_private", False)
    if type(value) is not bool:
        raise ValidationError("allow_private must be a boolean")
    return value


def required(params, key):
    value = params.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValidationError("%s is required" % key)
    return value.strip()


def number(params, key, minimum, maximum, default=None, integer=False):
    value = params.get(key, default)
    if isinstance(value, bool):
        raise ValidationError("%s must be a number" % key)
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValidationError("%s must be a number" % key) from None
    if not math.isfinite(value) or not minimum <= value <= maximum or (integer and not value.is_integer()):
        raise ValidationError("%s must be %s-%s%s" % (key, minimum, maximum, " (integer)" if integer else ""))
    return int(value) if integer else value


def text(value, limit=400):
    if not isinstance(value, str):
        raise RuntimeError("Data endpoint returned a non-text display field")
    return re.sub(r"\s+", " ", value).strip()[:limit]


def scalar_text(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, allow_nan=False)


def card(title, children, source):
    return notify.check_overlay_request({"size": "l", "root": {"type": "stack", "gap": 14, "children": [
        {"type": "text", "text": text(title), "size": "l", "weight": "strong"},
        *children, {"type": "divider"}, {"type": "status", "label": text(source, 40), "state": "online"}]}})
