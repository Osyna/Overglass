"""Saved overlay designs: a named, validated overlay card (theme, layout, widgets) the user built once and
shows again from the web UI, the CLI, a scene step ({"type": "overlay", "design": name}) or Home Assistant.
Stored at config_dir()/designs.json with the same atomic-tempfile pattern as every other store."""
import json
import os
import tempfile
import threading

from . import notify
from .config import config_dir
from .errors import ValidationError

FILE = "designs.json"
NAME_MAX = 60
LOCK = threading.RLock()


def check_name(name):
    if not isinstance(name, str) or not (1 <= len(name) <= NAME_MAX) or name.strip() != name:
        raise ValidationError("A design name must be 1-%d characters with no leading/trailing space" % NAME_MAX)
    return name


def check_design(body) -> dict:
    """A design is exactly one overlay card as POST /api/overlay accepts it (never a hide request)."""
    card = notify.check_overlay_request(body)
    if card.get("hide"):
        raise ValidationError("A design is a card to show, not a hide request")
    return card


def _path(config_dir_override=None):
    return config_dir(config_dir_override) / FILE


def load(config_dir_override=None) -> dict:
    """{"name": <validated card>}, or {} if nothing has been saved yet."""
    try:
        doc = json.loads(_path(config_dir_override).read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise ValidationError("designs.json is unreadable: %s" % error) from None
    if not isinstance(doc, dict) or not all(isinstance(v, dict) and ("root" in v or "regions" in v) for v in doc.values()):
        raise ValidationError("designs.json is malformed")
    return doc


def _write(designs, config_dir_override):
    directory = config_dir(config_dir_override)
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=".designs-", dir=directory)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(designs, handle, indent=2)
            handle.write("\n")
        os.replace(temp_name, directory / FILE)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def save(name, body, config_dir_override=None) -> dict:
    card = check_design(body)
    with LOCK:
        designs = load(config_dir_override)
        designs[check_name(name)] = card
        _write(designs, config_dir_override)
    return card


def delete(name, config_dir_override=None):
    with LOCK:
        designs = load(config_dir_override)
        if name not in designs:
            raise ValidationError("No such design: %s" % name)
        del designs[name]
        _write(designs, config_dir_override)


def show(transport, name, config_dir_override=None) -> str:
    designs = load(config_dir_override)
    if name not in designs:
        raise ValidationError("No such design: %s" % name)
    return notify.overlay_show(transport, designs[name])
