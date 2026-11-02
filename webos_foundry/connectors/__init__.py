"""Data sources that produce overlay cards without needing a TV connection."""
from . import football
from .. import notify
from ..errors import ValidationError

CONNECTORS = {"football": football.poll}


def run(name, params, transport) -> str:
    """Poll a registered connector and show its card on the TV."""
    if not isinstance(name, str) or name not in CONNECTORS:
        raise ValidationError("Unknown connector: %s" % name)
    return notify.overlay_show(transport, CONNECTORS[name](params))
