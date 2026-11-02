"""Exception types shared by every webos_foundry module."""


class WebosFoundryError(Exception):
    """Base class for every error this package raises on purpose."""


class ConfigError(WebosFoundryError):
    """The config file is missing, unreadable or malformed."""


class NotPairedError(WebosFoundryError):
    """No paired TV; run `wof pair --host <ip> --root-key <path>`."""


class TransportError(WebosFoundryError):
    """The TV rejected a command or could not be reached; the message is the TV's stderr when known."""


class TvBusyError(TransportError):
    """The TV-side lock is held by another job (processing, say, settings change)."""


class Cancelled(WebosFoundryError):
    """The caller cancelled a long-running job."""


class ValidationError(ValueError):
    """A bad argument, rejected before anything is sent to the TV."""
