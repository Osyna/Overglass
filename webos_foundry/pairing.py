"""`wof pair`: use the user's existing root key once to install the dispatcher and a dedicated restricted key.

The root key is only ever an argument of the one-off RootTransport below: its path is never stored in the
config, in a file or in a log, and the object is dropped when pair() returns (ARCHITECTURE.md §6).
"""
import re
import secrets
import shutil
import socket
import subprocess
from pathlib import Path

from . import install as install_module
from .config import Config, config_dir as resolve_config_dir
from .errors import ConfigError, TransportError, ValidationError
from .transport import SSHTransport, run_ssh, ssh_argv

REMOTE_DIR = "/var/lib/webosbrew/webos-foundry"
DISPATCHER = REMOTE_DIR + "/dispatch.sh"
AUTHORIZED_KEYS = "/home/root/.ssh/authorized_keys"
KEY_OPTIONS = ('command="sh %s",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,restrict'
               % DISPATCHER)
HOST_RE = re.compile(r"[A-Za-z0-9._:-]+")
PUSH_DISPATCHER = ("mkdir -p {d} && cat > {f}.new && chmod 755 {f}.new && mv {f}.new {f}"
                   .format(d=REMOTE_DIR, f=DISPATCHER))
# Append the key line (stdin) to authorized_keys unless an identical line is already there.
APPEND_KEY = ("mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh && touch {a} && chmod 600 {a} && "
              'line=$(cat) && { grep -qxF -- "$line" {a} || printf \'%s\\n\' "$line" >> {a}; }'
              ).replace("{a}", AUTHORIZED_KEYS)


class RootTransport:
    """One-off transport using the user's own unrestricted root key; pins the host key on first contact."""

    def __init__(self, host, port, key_path, known_hosts_path):
        self._args = dict(host=host, port=port, key_path=str(key_path), known_hosts_path=str(known_hosts_path),
                          host_key_checking="accept-new")

    def run(self, command, data=b"", timeout=20):
        return run_ssh(ssh_argv(command=command, **self._args), data, timeout)

    def run_streaming(self, command, timeout=20):
        raise TransportError("The root transport does not stream")


def authorized_line(public_key: str) -> str:
    """The restricted authorized_keys line for an `ssh-ed25519 AAAA... [comment]` public key."""
    fields = public_key.split()
    if len(public_key.strip().splitlines()) != 1 or len(fields) < 2 or fields[0] != "ssh-ed25519" \
            or not re.fullmatch(r"[A-Za-z0-9+/=]+", fields[1]):
        raise ValidationError("Unexpected public key format")
    comment = re.sub(r"[^A-Za-z0-9._-]", "-", socket.gethostname()) or "host"
    return "%s %s %s wof@%s" % (KEY_OPTIONS, fields[0], fields[1], comment)


def _keygen(key_path: Path) -> str:
    """Create the dedicated ed25519 key if it is missing (re-pairing reuses it); returns the public key."""
    if shutil.which("ssh-keygen") is None:
        raise RuntimeError("ssh-keygen is required by `wof pair` (install the OpenSSH client tools)")
    if not key_path.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "webos-foundry", "-f", str(key_path)],
                       stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=30)
    result = subprocess.run(["ssh-keygen", "-y", "-f", str(key_path)], stdin=subprocess.DEVNULL,
                            capture_output=True, check=True, timeout=30)
    return result.stdout.decode().strip()


def pair(host, root_key_path, *, port=22, config_dir=None, root=None, transport_factory=SSHTransport) -> Config:
    """Pair with the TV at `host`; returns the saved Config. `root` and `transport_factory` exist so tests can
    inject fakes: `root` replaces the RootTransport, `transport_factory(config)` the restricted-key transport."""
    if not isinstance(host, str) or not HOST_RE.fullmatch(host):
        raise ValidationError("Host must be an IP address or hostname")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValidationError("Port must be an integer 1-65535")
    key = Path(root_key_path).expanduser()
    if root is None and not key.is_file():
        raise ValidationError("Root key file not found: %s" % key)
    directory = resolve_config_dir(config_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        config = Config.load(config_dir)
    except ConfigError:
        config = Config.for_dir(directory)
    config.tv_host, config.ssh_port = host, port
    config.key_path = config.key_path or str(directory / "id_ed25519")
    config.known_hosts_path = config.known_hosts_path or str(directory / "known_hosts")
    config.server_token = config.server_token or secrets.token_urlsafe(32)

    line = authorized_line(_keygen(Path(config.key_path)))
    root = root or RootTransport(host, port, key, config.known_hosts_path)
    root.run(PUSH_DISPATCHER, data=(install_module.assets_dir() / "dispatch.sh").read_bytes(), timeout=30)
    root.run(APPEND_KEY, data=(line + "\n").encode(), timeout=30)
    config.save(config_dir)
    del root, key  # the root key is not needed again, and nothing above stored it

    install_module.install(transport_factory(config))
    return config
