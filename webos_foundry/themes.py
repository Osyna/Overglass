"""Named reusable overlay themes using the existing private atomic store pattern."""
import threading

from . import designs, notify
from .errors import ValidationError

FILE = "themes.json"
LOCK = threading.RLock()


def load(config_dir_override=None):
    with LOCK:
        doc = designs._read_file(FILE, config_dir_override)
        if not isinstance(doc, dict):
            raise ValidationError("themes.json is malformed")
        return {designs.check_name(name): notify._check_theme(theme) for name, theme in doc.items()}


def save(name, body, config_dir_override=None):
    name, theme = designs.check_name(name), notify._check_theme(body)
    with LOCK:
        saved = load(config_dir_override)
        saved[name] = theme
        designs._commit({FILE: saved}, config_dir_override)
    return theme


def delete(name, config_dir_override=None):
    with LOCK:
        saved = load(config_dir_override)
        if name not in saved:
            raise ValidationError("No such theme: %s" % name)
        del saved[name]
        designs._commit({FILE: saved}, config_dir_override)
