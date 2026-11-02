"""Builds the exact SSH_ORIGINAL_COMMAND strings `tv-assets/dispatch.sh` accepts (ARCHITECTURE.md §3).

GRAMMAR holds one anchored regex per verb: the same grammar dispatch.sh enforces on the TV. Every builder
checks its arguments, builds the string, and refuses to return anything GRAMMAR would not accept, so a bad
argument fails here with ValidationError instead of as a TV-side rejection.
"""
import re
from typing import Optional

from .errors import ValidationError

REMOTE_ACTIONS = ("wake", "power_off", "home", "back", "up", "down", "left", "right", "ok",
                  "hdmi", "volume", "volume_up", "volume_down", "mute", "unmute")
INSTALL_FILES = ("status.sh", "details.js", "notify.js", "settings.js", "remote.js",
                 "process-image.js", "process-audio.js", "apps.js", "dispatch.sh")
REMOTE_DIR = "/var/lib/webosbrew/webos-foundry"
LOCK = "/tmp/webos-foundry.lock"

_NAME = r"[A-Za-z][A-Za-z0-9_]*"
_PROFILE = r"[A-Za-z][A-Za-z0-9_-]*"
_B64 = r"[A-Za-z0-9+/]"
# One path component of a pushed tree: no leading dot (so never "." / ".." / a dotfile), a bounded charset.
_PART = r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}"
_TREE_PATH = r"%s(?:/%s){1,7}" % (_PART, _PART)  # at least one directory: never a top-level asset such as dispatch.sh
HOOK_PREFIX = "webos-foundry-"
_HOOK = HOOK_PREFIX + r"[a-z0-9-]{1,48}"
TREE_MODES = ("put", "begin", "more", "end")  # put = whole file; begin/more/end = chunks of one file (atomic rename on end)
MAX_TREE_PATH = 200
_REMOTE_PLAIN = "|".join(action for action in REMOTE_ACTIONS if action not in ("hdmi", "volume"))

GRAMMAR = {verb: re.compile(pattern) for verb, pattern in {
    "status": r"status",
    "details": r"details",
    "remote": r"remote (?:(?:%s)|hdmi [1-4]|volume (?:[0-9]|[1-9][0-9]|100))" % _REMOTE_PLAIN,
    "settings-list": r"settings-list",
    "settings-set": r"settings-set %s %s %s{1,4000}={0,2}" % (_NAME, _NAME, _B64),
    "notify-toast": r"notify-toast %s{1,400}={0,2}" % _B64,
    "notify-say": r"notify-say %s{1,400}={0,2}(?: [0-9]{1,2})?" % _B64,
    "notify-overlay": r"notify-overlay",
    "screenshot": r"screenshot [0-9]{2,4} [0-9]{2,4} (?:jpg|png)",
    "stream-start": r"stream-start [0-9]{2,4} [0-9]{2,4} [0-9]{1,3} [0-9]{1,4} [0-5]",
    "process-image": r"process-image %s [0-9]{2,4} [0-9]{2,4}" % _PROFILE,
    "process-audio": r"process-audio %s [0-9]{1,2}" % _PROFILE,
    "idle-wait": r"idle-wait",
    "install": r"install (?:%s)" % "|".join(re.escape(name) for name in INSTALL_FILES),
    "install-overlay": r"install-overlay",
    "install-status": r"install-status",
    "uninstall-overlay": r"uninstall-overlay",
    "install-vtcap": r"install-vtcap",
    "uninstall-vtcap": r"uninstall-vtcap",
    "uninstall-all": r"uninstall-all",
    "app-list": r"app-list",
    "app-install": r"app-install %s{1,1000}={0,2}" % _B64,
    "app-uninstall": r"app-uninstall %s{1,200}={0,2}" % _B64,
    "install-tree": r"install-tree (?=.{1,%d} )%s (?:%s)" % (MAX_TREE_PATH, _TREE_PATH, "|".join(TREE_MODES)),
    "install-hook": r"install-hook %s" % _HOOK,
    "run-hook": r"run-hook %s (?:start|stop)" % _HOOK,
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
    if action == "volume":
        if type(value) is not int or not 0 <= value <= 100:
            raise ValidationError("Volume must be the integer 0-100")
        return _built("remote", "remote volume %d" % value)
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


def build_notify_overlay() -> str:
    return "notify-overlay"


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


def build_install(name) -> str:
    if name not in INSTALL_FILES:
        raise ValidationError("Unknown TV file: %s" % (name,))
    return _built("install", "install %s" % name)


def build_install_status() -> str:
    return "install-status"


def build_install_overlay() -> str:
    return _built("install-overlay", "install-overlay")


def build_uninstall_overlay() -> str:
    return "uninstall-overlay"


def build_install_vtcap() -> str:
    return _built("install-vtcap", "install-vtcap")


def build_uninstall_vtcap() -> str:
    return "uninstall-vtcap"


def build_uninstall_all() -> str:
    return "uninstall-all"


def build_app_list() -> str:
    return "app-list"


def build_app_install(b64) -> str:
    return _built("app-install", "app-install " + _text(b64, "Payload"))


def build_app_uninstall(b64) -> str:
    return _built("app-uninstall", "app-uninstall " + _text(b64, "Payload"))


def build_install_tree(path, mode) -> str:
    return _built("install-tree", "install-tree %s %s" % (_text(path, "Path"), _text(mode, "Mode")))


def build_install_hook(name) -> str:
    return _built("install-hook", "install-hook %s" % _text(name, "Hook name"))


def build_run_hook(name, action="start") -> str:
    return _built("run-hook", "run-hook %s %s" % (_text(name, "Hook name"), _text(action, "Action")))
