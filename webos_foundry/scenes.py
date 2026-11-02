"""Scenes: named sequences of remote/setting/overlay/wait steps, saved and run as one unit (ARCHITECTURE.md §11).

Stored as `$WEBOS_FOUNDRY_HOME/scenes.json`, mode 0600, the same temp-file-then-rename pattern as config.py.
A step's `remote`/`setting`/`overlay` fields are validated and, for `overlay`, compiled into a widget tree at
save time (PUT /api/scenes/{name}), so running a scene later never re-validates what was already checked.
"""
import json
import os
import tempfile
import time
from pathlib import Path

from . import designs, notify, tv
from .config import config_dir
from .dispatcher import REMOTE_ACTIONS
from .errors import ValidationError

FILE = "scenes.json"
NAME_MAX = 60
MAX_STEPS = 20
STEP_TYPES = ("remote", "setting", "overlay", "wait")
MAX_WAIT = 10  # pacing between steps, not a long pause: 20 steps * 10s is still a bounded synchronous request


def _check_name(name):
    if not isinstance(name, str) or not (1 <= len(name) <= NAME_MAX) or name.strip() != name:
        raise ValidationError("A scene name must be 1-%d characters with no leading/trailing space" % NAME_MAX)
    return name


def _check_step(step):
    if not isinstance(step, dict) or not isinstance(step.get("type"), str):
        raise ValidationError('Each step needs a "type"')
    kind = step["type"]
    if kind not in STEP_TYPES:
        raise ValidationError("Unknown step type %r; use one of %s" % (kind, ", ".join(STEP_TYPES)))
    if kind == "remote":
        action, value = step.get("action"), step.get("value")
        if action not in REMOTE_ACTIONS:
            raise ValidationError("Unknown remote action %r" % (action,))
        if set(step) - {"type", "action", "value"}:
            raise ValidationError("A remote step only takes action and value")
        return {"type": "remote", "action": action, "value": value}
    if kind == "setting":
        category, key = step.get("category"), step.get("key")
        if (category, key) not in tv.LABELS:
            raise ValidationError("Unknown setting %s.%s" % (category, key))
        if "value" not in step:
            raise ValidationError("A setting step needs a value")
        if set(step) - {"type", "category", "key", "value", "context"}:
            raise ValidationError("A setting step only takes category, key, value and context")
        return {"type": "setting", "category": category, "key": key, "value": step["value"],
                "context": step.get("context") or {}}
    if kind == "overlay":
        if "design" in step:
            if set(step) - {"type", "design"}:
                raise ValidationError("An overlay step takes either card or design, not both")
            return {"type": "overlay", "design": designs.check_name(step["design"])}
        if set(step) - {"type", "card"}:
            raise ValidationError("An overlay step only takes card")
        return {"type": "overlay", "card": notify.check_overlay_request(step.get("card"))}
    seconds = step.get("seconds")
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not (0 <= seconds <= MAX_WAIT):
        raise ValidationError("A wait step needs seconds between 0 and %d" % MAX_WAIT)
    if set(step) - {"type", "seconds"}:
        raise ValidationError("A wait step only takes seconds")
    return {"type": "wait", "seconds": seconds}


def check_scene(body) -> dict:
    """Validate a PUT /api/scenes/{name} body: {"steps": [...]}. Returns the compiled, storable form."""
    if not isinstance(body, dict) or set(body) - {"steps"}:
        raise ValidationError('A scene is {"steps": [...]}')
    steps = body.get("steps")
    if not isinstance(steps, list) or not (1 <= len(steps) <= MAX_STEPS):
        raise ValidationError("A scene needs 1-%d steps" % MAX_STEPS)
    return {"steps": [_check_step(step) for step in steps]}


def _path(config_dir_override=None):
    return config_dir(config_dir_override) / FILE


def load(config_dir_override=None) -> dict:
    """{"name": {"steps": [...]}}, or {} if no scenes have been saved yet."""
    try:
        doc = json.loads(_path(config_dir_override).read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise ValidationError("scenes.json is unreadable: %s" % error) from None
    if not isinstance(doc, dict) or not all(isinstance(v, dict) and isinstance(v.get("steps"), list)
                                             for v in doc.values()):
        raise ValidationError("scenes.json is malformed")
    return doc


def save(name, scene, config_dir_override=None):
    directory = config_dir(config_dir_override)
    directory.mkdir(parents=True, exist_ok=True)
    scenes = load(config_dir_override)
    scenes[_check_name(name)] = scene
    path = directory / FILE
    descriptor, temp_name = tempfile.mkstemp(prefix=".scenes-", dir=directory)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(scenes, handle, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def delete(name, config_dir_override=None):
    scenes = load(config_dir_override)
    if name not in scenes:
        raise ValidationError("No such scene: %s" % name)
    del scenes[name]
    directory = config_dir(config_dir_override)
    path = directory / FILE
    descriptor, temp_name = tempfile.mkstemp(prefix=".scenes-", dir=directory)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(scenes, handle, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def run_step(transport, step) -> str:
    kind = step["type"]
    if kind == "remote":
        return tv.remote(transport, step["action"], step.get("value"))
    if kind == "setting":
        return tv.set_setting(transport, step["category"], step["key"], step["value"], step["context"])
    if kind == "overlay":
        if "design" in step:  # resolved when the scene runs, so editing the design changes what the scene shows
            return designs.show(transport, step["design"])
        return notify.overlay_show(transport, step["card"])
    time.sleep(step["seconds"])
    return "Waited %gs" % step["seconds"]


def run_scene(transport, scene) -> list:
    """Runs every step in order, stopping at the first failure. Returns one message per completed step."""
    return [run_step(transport, step) for step in scene["steps"]]
