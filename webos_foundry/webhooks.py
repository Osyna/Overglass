"""Revocable capability URLs that run one saved scene."""
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


def _check_entry(scene, label):
    if not isinstance(scene, str) or not (1 <= len(scene) <= NAME_MAX) or scene.strip() != scene:
        raise ValidationError("A scene name must be 1-%d characters with no leading/trailing space" % NAME_MAX)
    if label is None:
        label = ""
    if not isinstance(label, str) or len(label) > NAME_MAX:
        raise ValidationError("A webhook label must be at most %d characters" % NAME_MAX)
    return {"scene": scene, "label": label}


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
        if not token or not isinstance(entry, dict) or set(entry) != {"scene", "label"}:
            raise ValidationError("webhooks.json is malformed")
        _check_entry(entry["scene"], entry["label"])
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


def create(scene, label=None, config_dir_override=None) -> str:
    entry = _check_entry(scene, label)
    with LOCK:
        saved = load(config_dir_override)
        token = secrets.token_urlsafe(24)
        while token in saved:
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
