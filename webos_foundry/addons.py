"""Installed addons: a connector wrapped with saved params, a refresh interval and where/how big to
show it. This module is pure storage/validation; `server.AddonsThread` is the background thread that
polls each enabled addon on its own interval and pushes the result to the TV -- "install once, it
stays live" (ARCHITECTURE.md section 12).

Only one overlay-type window can be visible on the TV at a time (FINDINGS.md, tested live): installing
or enabling an addon disables every other one, so there is never a confusing flicker between two addons
racing to show their card.
"""
import json
import os
import tempfile
import threading

from . import connectors, notify
from .config import config_dir
from .errors import ValidationError

FILE = "addons.json"
MIN_INTERVAL = 15
MAX_INTERVAL = 3600
DEFAULT_INTERVAL = 60
LOCK = threading.RLock()


def catalog() -> list:
    """Every registered connector as a browsable addon card: no config or network needed."""
    return [dict(meta, id=addon_id) for addon_id, meta in connectors.META.items()]


def _check_entry(addon_id, body):
    if addon_id not in connectors.CONNECTORS:
        raise ValidationError("Unknown addon: %s" % addon_id)
    if not isinstance(body, dict):
        raise ValidationError("Addon settings must be an object")
    params = body.get("params", {})
    if not isinstance(params, dict):
        raise ValidationError("params must be an object")
    interval = body.get("interval_seconds", connectors.META[addon_id].get("default_interval_seconds", DEFAULT_INTERVAL))
    if type(interval) is not int or not MIN_INTERVAL <= interval <= MAX_INTERVAL:
        raise ValidationError("interval_seconds must be an integer %d-%d" % (MIN_INTERVAL, MAX_INTERVAL))
    enabled = body.get("enabled", True)
    if type(enabled) is not bool:
        raise ValidationError("enabled must be true or false")
    out = {"params": params, "interval_seconds": interval, "enabled": enabled}
    if "position" in body:
        out["position"] = notify._check_enum(body["position"], notify.POSITIONS, "position")
    if "size" in body:
        out["size"] = notify._check_enum(body["size"], notify.SIZES, "size")
    return out


def _path(config_dir_override=None):
    return config_dir(config_dir_override) / FILE


def load(config_dir_override=None) -> dict:
    """{"connector_id": {"params", "interval_seconds", "enabled", "position"?, "size"?}}."""
    try:
        doc = json.loads(_path(config_dir_override).read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise ValidationError("addons.json is unreadable: %s" % error) from None
    if not isinstance(doc, dict) or not all(isinstance(v, dict) and isinstance(v.get("params"), dict)
                                             and isinstance(v.get("interval_seconds"), int)
                                             and isinstance(v.get("enabled"), bool) for v in doc.values()):
        raise ValidationError("addons.json is malformed")
    return doc


def _write(addons, config_dir_override=None):
    directory = config_dir(config_dir_override)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / FILE
    descriptor, temp_name = tempfile.mkstemp(prefix=".addons-", dir=directory)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(addons, handle, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def install(addon_id, body, config_dir_override=None) -> dict:
    """Save (or update) an installed addon. Enabling it disables every other installed addon, since
    only one overlay window can be visible at a time."""
    entry = _check_entry(addon_id, body)
    with LOCK:
        addons = load(config_dir_override)
        if entry["enabled"]:
            for other in addons.values():
                other["enabled"] = False
        addons[addon_id] = entry
        _write(addons, config_dir_override)
    return entry


def uninstall(addon_id, config_dir_override=None):
    with LOCK:
        addons = load(config_dir_override)
        if addon_id not in addons:
            raise ValidationError("No such installed addon: %s" % addon_id)
        del addons[addon_id]
        _write(addons, config_dir_override)


def preview(addon_id, params, transport) -> str:
    """Poll once and show the result now, without changing install state."""
    if addon_id not in connectors.CONNECTORS:
        raise ValidationError("Unknown addon: %s" % addon_id)
    return connectors.run(addon_id, params or {}, transport)


def card_for(addon_id, entry) -> dict:
    """Poll a connector and apply the addon's saved position/size, if any. Raises whatever poll()
    raises (ValidationError/RuntimeError); callers decide how to log or surface that."""
    card = connectors.CONNECTORS[addon_id](entry["params"])
    if "position" in entry:
        card["position"] = entry["position"]
    if "size" in entry:
        card["size"] = entry["size"]
    return card
