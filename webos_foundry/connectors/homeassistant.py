"""Home Assistant REST /api/states/{entity_id} with long-lived Bearer token.

url is the HA base URL. LAN access requires allow_private=True explicitly.
Text is the default. Explicit status mode maps one configured literal state to
one status and all other states to a second configured status. Stat mode needs
a finite decimal state and an increasing numeric scale; only the bar is clamped,
never the displayed measurement. Unknown/unavailable states are not numbers.
"""
import math
import re
from urllib.parse import urlsplit, urlunsplit

from ..datafetch import fetch_json
from .. import notify
from ..errors import ValidationError
from ._shared import LABEL, PRIVATE, card, number, parameters, private, required, text

META = {"name": "Home Assistant", "description": "Show an entity's real state using the Home Assistant REST API.",
        "category": "home", "default_interval_seconds": 60, "params_schema": [
        {"key": "url", "label": "Home Assistant base URL", "type": "string", "required": True},
        {"key": "token", "label": "Long-lived access token", "type": "secret", "required": True},
        {"key": "entity_id", "label": "Entity ID", "type": "string", "required": True}, LABEL, PRIVATE,
        {"key": "display", "label": "State presentation", "type": "select", "default": "text", "choices": [
            {"value": "text", "label": "State text"}, {"value": "status", "label": "Mapped status"},
            {"value": "stat", "label": "Numeric stat row"}]},
        {"key": "status_value", "label": "Exact HA state to match (required for status)", "type": "string",
         "description": "Literal match, e.g. on. No state meaning is inferred."},
        {"key": "status_match", "label": "Status for exact match", "type": "select", "default": "online",
         "choices": [{"value": state, "label": state.title()} for state in notify.STATES]},
        {"key": "status_other", "label": "Status for every other state", "type": "select", "default": "unknown",
         "choices": [{"value": state, "label": state.title()} for state in notify.STATES]},
        {"key": "stat_min", "label": "Stat scale minimum", "type": "number", "default": 0, "step": "any"},
        {"key": "stat_max", "label": "Stat scale maximum", "type": "number", "default": 100, "step": "any"}]}


def poll(params):
    parameters(params)
    display = params.get("display", "text")
    if display not in ("text", "status", "stat"):
        raise ValidationError("Home Assistant display must be text, status or stat")
    if display == "status":
        status_value = required(params, "status_value")
        status_match = params.get("status_match", "online")
        status_other = params.get("status_other", "unknown")
        if status_match not in notify.STATES or status_other not in notify.STATES:
            raise ValidationError("Home Assistant status mapping must use online, offline, degraded or unknown")
    elif display == "stat":
        minimum = number(params, "stat_min", -math.inf, math.inf, 0)
        maximum = number(params, "stat_max", -math.inf, math.inf, 100)
        if maximum <= minimum or not math.isfinite(maximum - minimum):
            raise ValidationError("Stat scale must have a finite span and maximum greater than minimum")
    base = required(params, "url")
    try:
        parts = urlsplit(base)
    except ValueError:
        raise ValidationError("Home Assistant base URL is invalid") from None
    if parts.query or parts.fragment:
        raise ValidationError("Home Assistant base URL must not have a query or fragment")
    entity = required(params, "entity_id")
    if not re.fullmatch(r"[a-z0-9_]+\.[a-z0-9_]+", entity):
        raise ValidationError("entity_id must have domain.entity form")
    endpoint = urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/") + "/api/states/" + entity, "", ""))
    data = fetch_json(endpoint, headers={"Authorization": "Bearer " + required(params, "token")}, allow_private=private(params))
    if not isinstance(data, dict) or not isinstance(data.get("state"), str) or not isinstance(data.get("attributes", {}), dict):
        raise RuntimeError("Home Assistant returned malformed entity state")
    attributes = data.get("attributes", {})
    state = text(data["state"], 300)
    unit = attributes.get("unit_of_measurement")
    if isinstance(unit, str) and unit:
        state += " " + text(unit, 40)
    title = params.get("label") or attributes.get("friendly_name") or entity
    if display == "status":
        widget = {"type": "status", "label": text(title, 40),
                  "state": status_match if data["state"] == status_value else status_other,
                  "detail": text(state, 24)}
        widgets = [widget]
    elif display == "stat":
        if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", data["state"]):
            raise RuntimeError("Home Assistant stat presentation requires a finite numeric entity state")
        value = float(data["state"])
        if not math.isfinite(value):
            raise RuntimeError("Home Assistant stat presentation requires a finite numeric entity state")
        measurement = "%g" % value
        if isinstance(unit, str) and unit:
            measurement += " " + text(unit, max(0, 15 - len(measurement)))
        widgets = [{"type": "stat", "label": text(title, 40), "left": measurement.strip(),
                    "right": text("%g max" % maximum, 16),
                    "fraction": max(0, min(1, (value - minimum) / (maximum - minimum)))},
                   {"type": "text", "text": "Scale: %g to %g" % (minimum, maximum), "size": "s", "color": "fg-2"}]
    else:
        widgets = [{"type": "text", "text": state, "size": "l"}]
    return card(title, widgets + [{"type": "text", "text": entity, "size": "s", "color": "fg-2"}], "Home Assistant")
