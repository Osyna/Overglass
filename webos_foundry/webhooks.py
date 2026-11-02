"""Revocable capability URLs that run one saved scene or render a saved design."""
import json
import os
import secrets
import tempfile
import threading

from .config import config_dir
from .errors import ValidationError

FILE = "webhooks.json"
NAME_MAX = 60
LOCK = threading.Lock()


def _check_entry(scene, label, design=None):
    target, kind = (design, "design") if design is not None else (scene, "scene")
    if design is not None and scene is not None:
        raise ValidationError("A webhook takes either scene or design, not both")
    if not isinstance(target, str) or not (1 <= len(target) <= NAME_MAX) or target.strip() != target:
        raise ValidationError("A %s name must be 1-%d characters with no leading/trailing space" % (kind, NAME_MAX))
    if label is None:
        label = ""
    if not isinstance(label, str) or len(label) > NAME_MAX:
        raise ValidationError("A webhook label must be at most %d characters" % NAME_MAX)
    return {kind: target, "label": label}


def load(config_dir_override=None) -> dict:
    try:
        saved = json.loads((config_dir(config_dir_override) / FILE).read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise ValidationError("webhooks.json is unreadable: %s" % error) from None
    if not isinstance(saved, dict):
        raise ValidationError("webhooks.json is malformed")
    for token, entry in saved.items():
        if not token or not isinstance(entry, dict) or set(entry) not in ({"scene", "label"}, {"design", "label"}):
            raise ValidationError("webhooks.json is malformed")
        _check_entry(entry.get("scene"), entry["label"], entry.get("design"))
    return saved


def _save(saved, config_dir_override):
    directory = config_dir(config_dir_override)
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=".webhooks-", dir=directory)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(saved, handle, indent=2)
            handle.write("\n")
        os.replace(temp_name, directory / FILE)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def create(scene=None, label=None, config_dir_override=None, *, design=None) -> str:
    entry = _check_entry(scene, label, design)
    with LOCK:
        saved = load(config_dir_override)
        token = secrets.token_urlsafe(24)
        while token in saved or token.startswith("-"):  # a leading dash would read as a CLI option
            token = secrets.token_urlsafe(24)
        saved[token] = entry
        _save(saved, config_dir_override)
    return token


def delete(token, config_dir_override=None):
    with LOCK:
        saved = load(config_dir_override)
        if not isinstance(token, str) or token not in saved:
            raise ValidationError("No such webhook")
        del saved[token]
        _save(saved, config_dir_override)


def resolve(token, config_dir_override=None):
    if not isinstance(token, str):
        return None
    return load(config_dir_override).get(token)


def render(entry, values=None, config_dir_override=None):
    """Apply only declared scalar targets, then resolve and validate before transport."""
    from . import bindings, designs
    if not isinstance(entry, dict) or set(entry) != {"design", "label"}:
        raise ValidationError("Only design webhooks accept scalar values")
    _check_entry(None, entry["label"], entry["design"])
    saved = designs.load(config_dir_override)
    if entry["design"] not in saved:
        raise ValidationError("No such design: %s" % entry["design"])
    return bindings.apply_values(saved[entry["design"]], {} if values is None else values)
