"""Builds the exact SSH_ORIGINAL_COMMAND strings `tv-assets/dispatch.sh` accepts (ARCHITECTURE.md §3).

GRAMMAR holds one anchored regex per verb: the same grammar dispatch.sh enforces on the TV. Every builder
checks its arguments, builds the string, and refuses to return anything GRAMMAR would not accept, so a bad
argument fails here with ValidationError instead of as a TV-side rejection.
"""
import re
from typing import Optional

from .errors import ValidationError

REMOTE_ACTIONS = ("wake", "power_off", "home", "back", "up", "down", "left", "right", "ok",
                  "hdmi", "volume_up", "volume_down", "mute", "unmute")
INSTALL_FILES = ("status.sh", "details.js", "notify.js", "settings.js", "remote.js",
                 "process-image.js", "process-audio.js", "dispatch.sh")
REMOTE_DIR = "/var/lib/webosbrew/webos-foundry"
LOCK = "/tmp/webos-foundry.lock"

_NAME = r"[A-Za-z][A-Za-z0-9_]*"
_PROFILE = r"[A-Za-z][A-Za-z0-9_-]*"
_B64 = r"[A-Za-z0-9+/]"
_REMOTE_PLAIN = "|".join(action for action in REMOTE_ACTIONS if action != "hdmi")

GRAMMAR = {verb: re.compile(pattern) for verb, pattern in {
    "status": r"status",
    "details": r"details",
    "remote": r"remote (?:(?:%s)|hdmi [1-4])" % _REMOTE_PLAIN,
    "settings-list": r"settings-list",
    "settings-set": r"settings-set %s %s %s{1,4000}={0,2}" % (_NAME, _NAME, _B64),
    "notify-toast": r"notify-toast %s{1,400}={0,2}" % _B64,
    "notify-say": r"notify-say %s{1,400}={0,2}(?: [0-9]{1,2})?" % _B64,
    "notify-overlay": r"notify-overlay %s{1,8000}={0,2}" % _B64,
    "screenshot": r"screenshot [0-9]{2,4} [0-9]{2,4} (?:jpg|png)",
    "stream-start": r"stream-start [0-9]{2,4} [0-9]{2,4} [0-9]{1,3} [0-9]{1,4} [0-5]",
    "process-image": r"process-image %s [0-9]{2,4} [0-9]{2,4}" % _PROFILE,
    "process-audio": r"process-audio %s [0-9]{1,2}" % _PROFILE,
    "idle-wait": r"idle-wait",
    "install": r"install (?:%s) %s+={0,2}" % ("|".join(re.escape(name) for name in INSTALL_FILES), _B64),
    "install-overlay": r"install-overlay %s+={0,2}" % _B64,
    "install-status": r"install-status",
    "uninstall-overlay": r"uninstall-overlay",
    "install-vtcap": r"install-vtcap %s+={0,2}" % _B64,
    "uninstall-vtcap": r"uninstall-vtcap",
    "uninstall-all": r"uninstall-all",
}.items()}


def verb_of(command) -> Optional[str]:
    """The verb `command` matches under GRAMMAR, or None."""
    if not isinstance(command, str):
        return None
    for verb, pattern in GRAMMAR.items():
        if pattern.fullmatch(command):
            return verb
    return None


def _built(verb, command):
    if not GRAMMAR[verb].fullmatch(command):
        raise ValidationError("Invalid arguments for %s" % verb)
    return command


def _int(value, what):
    if type(value) is not int:
        raise ValidationError("%s must be an integer" % what)
    return str(value)


def _text(value, what):
    if not isinstance(value, str):
        raise ValidationError("%s must be text" % what)
    return value


def build_status() -> str:
    return "status"


def build_details() -> str:
    return "details"


def build_remote(action, value=None) -> str:
    if action not in REMOTE_ACTIONS:
        raise ValidationError("Unknown remote action")
    if action == "hdmi":
        if type(value) is not int or not 1 <= value <= 4:
            raise ValidationError("HDMI input must be the integer 1-4")
        return _built("remote", "remote hdmi %d" % value)
    if value is not None:
        raise ValidationError("This remote action takes no value")
    return _built("remote", "remote " + action)


def build_settings_list() -> str:
    return "settings-list"


def build_settings_set(category, key, b64) -> str:
    return _built("settings-set", "settings-set %s %s %s" % (
        _text(category, "Category"), _text(key, "Key"), _text(b64, "Payload")))


def build_notify_toast(b64) -> str:
    return _built("notify-toast", "notify-toast " + _text(b64, "Payload"))


def build_notify_say(b64, volume=None) -> str:
    command = "notify-say " + _text(b64, "Payload")
    if volume is not None:
        command += " " + _int(volume, "Volume")
    return _built("notify-say", command)


def build_notify_overlay(b64) -> str:
    return _built("notify-overlay", "notify-overlay " + _text(b64, "Payload"))


def build_screenshot(width, height, fmt) -> str:
    return _built("screenshot", "screenshot %s %s %s" % (_int(width, "Width"), _int(height, "Height"), _text(fmt, "Format")))


def build_stream_start(width, height, fps, seconds, dump) -> str:
    return _built("stream-start", "stream-start %s %s %s %s %s" % (
        _int(width, "Width"), _int(height, "Height"), _int(fps, "FPS"), _int(seconds, "Seconds"), _int(dump, "Dump")))


def build_process_image(profile, width, height) -> str:
    return _built("process-image", "process-image %s %s %s" % (
        _text(profile, "Profile"), _int(width, "Width"), _int(height, "Height")))


def build_process_audio(profile, seconds) -> str:
    return _built("process-audio", "process-audio %s %s" % (_text(profile, "Profile"), _int(seconds, "Seconds")))


def build_idle_wait() -> str:
    return "idle-wait"


def build_install(name, b64) -> str:
    if name not in INSTALL_FILES:
        raise ValidationError("Unknown TV file: %s" % (name,))
    return _built("install", "install %s %s" % (name, _text(b64, "Payload")))


def build_install_status() -> str:
    return "install-status"


def build_install_overlay(b64) -> str:
    return _built("install-overlay", "install-overlay " + _text(b64, "Payload"))


def build_uninstall_overlay() -> str:
    return "uninstall-overlay"


def build_install_vtcap(b64) -> str:
    return _built("install-vtcap", "install-vtcap " + _text(b64, "Payload"))


def build_uninstall_vtcap() -> str:
    return "uninstall-vtcap"


def build_uninstall_all() -> str:
    return "uninstall-all"
