"""Saved design rotations; due() tracks each independent rotation without catch-up bursts."""
import math
import secrets
import threading
import time

from . import addons, designs
from .errors import ValidationError

FILE = "rotations.json"
LOCK = threading.RLock()


def check_entry(body):
    if not isinstance(body, dict) or set(body) - {"designs", "interval_seconds", "enabled"}:
        raise ValidationError("A rotation takes designs, interval_seconds and enabled")
    names, interval, enabled = body.get("designs"), body.get("interval_seconds"), body.get("enabled", True)
    if not isinstance(names, list) or not 1 <= len(names) <= 20:
        raise ValidationError("A rotation needs 1-20 design names")
    names = [designs.check_name(name) for name in names]
    if type(interval) is not int or not 15 <= interval <= 86400:
        raise ValidationError("Rotation interval_seconds must be an integer 15-86400")
    if type(enabled) is not bool:
        raise ValidationError("Rotation enabled must be a boolean")
    return {"designs": names, "interval_seconds": interval, "enabled": enabled}


def load(config_dir_override=None):
    with LOCK:
        doc = designs._read_file(FILE, config_dir_override)
        if not isinstance(doc, dict):
            raise ValidationError("rotations.json is malformed")
        for entry_id, entry in doc.items():
            if not isinstance(entry_id, str) or not entry_id or not isinstance(entry, dict) or entry.get("id") != entry_id:
                raise ValidationError("rotations.json is malformed")
            check_entry({key: value for key, value in entry.items() if key != "id"})
        return doc


def save(entry_id, entry, config_dir_override=None):
    checked = check_entry(entry)
    with LOCK, addons.LOCK:
        entries = load(config_dir_override)
        available = designs.load(config_dir_override)
        if any(name not in available for name in checked["designs"]):
            raise ValidationError("Every rotation design must exist")
        if entry_id is None:
            entry_id = secrets.token_urlsafe(6)
            while entry_id in entries or entry_id.startswith("-"):
                entry_id = secrets.token_urlsafe(6)
        elif not isinstance(entry_id, str) or entry_id not in entries:
            raise ValidationError("No such rotation entry")
        if checked["enabled"]:
            if any(key != entry_id and other["enabled"] for key, other in entries.items()):
                raise ValidationError("Disable the active rotation before enabling another rotation")
            if any(other["enabled"] for other in addons.load(config_dir_override).values()):
                raise ValidationError("Disable the active addon before enabling a rotation")
        entries[entry_id] = {"id": entry_id, **checked}
        designs._commit({FILE: entries}, config_dir_override)
        return entry_id


def delete(entry_id, config_dir_override=None):
    with LOCK:
        entries = load(config_dir_override)
        if entry_id not in entries:
            raise ValidationError("No such rotation entry")
        del entries[entry_id]
        designs._commit({FILE: entries}, config_dir_override)


def due(entries, state, now=None):
    """Return (rotation id, design name); callers own state and serialize actual TV shows."""
    now = time.time() if now is None else now
    if type(now) not in (int, float) or not math.isfinite(now):
        raise ValidationError("Rotation clock must be finite seconds")
    for entry_id in list(state):
        if entry_id not in entries:
            del state[entry_id]
    result = []
    for entry_id, entry in entries.items():
        checked = check_entry({key: value for key, value in entry.items() if key != "id"})
        if not checked["enabled"]:
            state.pop(entry_id, None)
            continue
        signature = (tuple(checked["designs"]), checked["interval_seconds"])
        previous = state.get(entry_id)
        if previous is None or previous["signature"] != signature:
            previous = {"signature": signature, "next_at": now, "index": 0}
        if now >= previous["next_at"]:
            result.append((entry_id, checked["designs"][previous["index"]]))
            previous = {"signature": signature, "next_at": now + checked["interval_seconds"],
                        "index": (previous["index"] + 1) % len(checked["designs"])}
        state[entry_id] = previous
    return result
