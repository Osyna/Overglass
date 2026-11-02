"""Data sources that produce overlay cards without needing a TV connection."""
from . import calendar, football, homeassistant, json_api, rss, weather
from .. import notify
from ..errors import ValidationError

_MODULES = {"football": football, "json": json_api, "homeassistant": homeassistant,
            "weather": weather, "calendar": calendar, "rss": rss}
CONNECTORS = {name: module.poll for name, module in _MODULES.items()}
META = {name: module.META for name, module in _MODULES.items()}


def run(name, params, transport) -> str:
    """Poll a registered connector and show its card on the TV."""
    if not isinstance(name, str) or name not in CONNECTORS:
        raise ValidationError("Unknown connector: %s" % name)
    return notify.overlay_show(transport, CONNECTORS[name](params))
