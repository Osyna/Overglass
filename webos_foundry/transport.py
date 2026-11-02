"""How the host talks to the TV: the Transport protocol and the `ssh`-binary implementation."""
import subprocess
from typing import List, Protocol

from .config import Config
from .errors import TransportError, TvBusyError

BUSY_EXIT = 75  # flock -E 75 in dispatch.sh: the TV lock is held


class Transport(Protocol):
    def run(self, command: str, data: bytes = b"", timeout: float = 20) -> bytes: ...

    def run_streaming(self, command: str, timeout: float = 20) -> subprocess.Popen: ...


def ssh_argv(*, host: str, port: int, key_path: str, known_hosts_path: str, command: str,
             host_key_checking: str = "yes") -> List[str]:
    """The `ssh` command line. `command` becomes SSH_ORIGINAL_COMMAND for the key's forced command."""
    return [
        "ssh", "-T", "-i", str(key_path), "-p", str(port),
        "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=" + host_key_checking, "-o", "UserKnownHostsFile=" + str(known_hosts_path),
        # The TV's sshd has no post-quantum key exchange; its per-call warning would bury real TV errors.
        "-o", "WarnWeakCrypto=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=5",
        "root@" + host, command,
    ]


def run_ssh(argv: List[str], data: bytes = b"", timeout: float = 20) -> bytes:
    """Run one ssh invocation; TransportError (TvBusyError if the TV lock is held) on any failure."""
    try:
        result = subprocess.run(argv, input=data, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise TransportError("TV did not answer within %d s" % timeout) from None
    except OSError as error:
        raise TransportError("Cannot run ssh: %s" % error) from None
    if result.returncode:
        message = result.stderr.decode(errors="replace")[-2500:].strip() or "TV SSH command failed"
        raise (TvBusyError if result.returncode == BUSY_EXIT or "busy" in message.lower() else TransportError)(message)
    return result.stdout


class SSHTransport:
    def __init__(self, config: Config):
        self.config = config

    def _argv(self, command: str) -> List[str]:
        c = self.config
        return ssh_argv(host=c.tv_host, port=c.ssh_port, key_path=c.key_path,
                        known_hosts_path=c.known_hosts_path, command=command)

    def run(self, command: str, data: bytes = b"", timeout: float = 20) -> bytes:
        return run_ssh(self._argv(command), data, timeout)

    def run_streaming(self, command: str, timeout: float = 20) -> subprocess.Popen:
        # `timeout` is accepted for protocol symmetry; the stream's own length is the command's `seconds`.
        try:
            return subprocess.Popen(self._argv(command), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as error:
            raise TransportError("Cannot run ssh: %s" % error) from None
