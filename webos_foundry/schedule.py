"""Local-time scene schedules; the server thread owns once-per-minute firing."""
import json
import os
import re
import secrets
import tempfile
import threading
from datetime import datetime

from .config import config_dir
from .errors import ValidationError

FILE = "schedule.json"
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
LOCK = threading.RLock()


def check_entry(body):
    if not isinstance(body, dict) or set(body) - {"scene", "time", "days", "enabled"}:
        raise ValidationError("A schedule entry takes scene, time, days and enabled")
    scene, clock = body.get("scene"), body.get("time")
    days, enabled = body.get("days", []), body.get("enabled", True)
    if not isinstance(scene, str) or not scene.strip():
        raise ValidationError("A schedule entry needs a non-empty scene name")
    if not isinstance(clock, str) or not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", clock):
        raise ValidationError("Schedule time must be HH:MM (00:00-23:59)")
    if not isinstance(days, list) or any(not isinstance(day, str) or day not in DAYS for day in days):
        raise ValidationError("Schedule days must be a list of mon, tue, wed, thu, fri, sat, sun")
    if not isinstance(enabled, bool):
        raise ValidationError("Schedule enabled must be a boolean")
    return {"scene": scene, "time": clock, "days": list(days), "enabled": enabled}


def load(config_dir_override=None):
    try:
        doc = json.loads((config_dir(config_dir_override) / FILE).read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise ValidationError("schedule.json is unreadable: %s" % error) from None
    if not isinstance(doc, dict):
        raise ValidationError("schedule.json is malformed")
    for entry_id, entry in doc.items():
        if not isinstance(entry, dict) or entry.get("id") != entry_id:
            raise ValidationError("schedule.json is malformed")
        check_entry({key: value for key, value in entry.items() if key != "id"})
    return doc


def _write(entries, config_dir_override):
    directory = config_dir(config_dir_override)
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=".schedule-", dir=directory)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(entries, handle, indent=2)
            handle.write("\n")
        os.replace(temp_name, directory / FILE)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def save(entry_id, entry, config_dir_override=None):
    checked = check_entry(entry)
    with LOCK:
        entries = load(config_dir_override)
        if entry_id is None:
            entry_id = secrets.token_urlsafe(6)
            while entry_id in entries:
                entry_id = secrets.token_urlsafe(6)
        elif entry_id not in entries:
            raise ValidationError("No such schedule entry: %s" % entry_id)
        entries[entry_id] = {"id": entry_id, **checked}
        _write(entries, config_dir_override)
    return entry_id


def delete(entry_id, config_dir_override=None):
    with LOCK:
        entries = load(config_dir_override)
        if entry_id not in entries:
            raise ValidationError("No such schedule entry: %s" % entry_id)
        del entries[entry_id]
        _write(entries, config_dir_override)


def due(entries, now=None):
    """Matching IDs, not deduplicated runs: once-per-minute firing is the thread's job."""
    now = datetime.now() if now is None else now
    clock, day = now.strftime("%H:%M"), DAYS[now.weekday()]
    return [entry_id for entry_id, entry in entries.items()
            if entry.get("enabled", True) is True and entry["time"] == clock
            and (not entry.get("days") or day in entry["days"])]
