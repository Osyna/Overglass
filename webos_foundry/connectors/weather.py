"""Current conditions from the key-free Open-Meteo Forecast API, in metric units."""
import math
from urllib.parse import urlencode

from ..datafetch import fetch_json
from ._shared import LABEL, card, number, parameters, text

API_URL = "https://api.open-meteo.com/v1/forecast"
META = {"name": "Weather", "description": "Current temperature, humidity and wind from Open-Meteo (no API key).",
        "category": "weather", "default_interval_seconds": 900, "params_schema": [
        {"key": "latitude", "label": "Latitude", "type": "number", "required": True, "min": -90, "max": 90, "step": "any"},
        {"key": "longitude", "label": "Longitude", "type": "number", "required": True, "min": -180, "max": 180, "step": "any"}, LABEL]}


def poll(params):
    parameters(params)
    latitude = number(params, "latitude", -90, 90)
    longitude = number(params, "longitude", -180, 180)
    data = fetch_json(API_URL + "?" + urlencode({"latitude": latitude, "longitude": longitude,
        "current": "temperature_2m,relative_humidity_2m,wind_speed_10m", "timezone": "UTC"}))
    try:
        current, units = data["current"], data["current_units"]
        items = []
        for key, label in (("temperature_2m", "Temperature"), ("relative_humidity_2m", "Humidity"), ("wind_speed_10m", "Wind")):
            value = current[key]
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError
            items.append({"label": label, "value": text("%s %s" % (value, units[key]), 40)})
        timestamp = text(current["time"], 60)
    except (KeyError, TypeError, ValueError):
        raise RuntimeError("Open-Meteo returned malformed current conditions") from None
    return card(params.get("label") or "Weather", [{"type": "meta", "items": items},
        {"type": "text", "text": timestamp + " UTC", "size": "s", "color": "fg-2"}], "Open-Meteo · CC BY 4.0")
