"""Generic HTTP JSON scalar cards. path is a dot path or RFC 6901 pointer.

Objects/arrays are rejected; no string interpolation or source HTML is executed.
Authorization, when needed, is a Bearer header, never a query parameter.
"""
from ..datafetch import fetch_json, scalar_at
from ..errors import ValidationError
from ._shared import LABEL, PRIVATE, URL, card, parameters, private, required, scalar_text, text

META = {"name": "JSON API", "description": "Display a real scalar value from an HTTP JSON endpoint.",
        "category": "data", "default_interval_seconds": 60, "params_schema": [URL,
        {"key": "path", "label": "Scalar path", "type": "string", "default": "",
         "description": "Dot path (current.temperature) or JSON pointer (/current/temperature); empty selects the root."},
        LABEL, {"key": "token", "label": "Bearer token (optional)", "type": "secret"}, PRIVATE]}


def poll(params):
    parameters(params)
    token = params.get("token", "")
    if not isinstance(token, str):
        raise ValidationError("token must be text")
    data = fetch_json(required(params, "url"), headers={"Authorization": "Bearer " + token} if token else None,
                      allow_private=private(params))
    value = scalar_at(data, params.get("path", ""))
    return card(params.get("label") or "JSON API", [{"type": "text", "text": text(scalar_text(value)), "size": "l"}], "JSON API")
