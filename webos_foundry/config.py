"""On-disk config: `$WEBOS_FOUNDRY_HOME/config.json` (default `~/.config/webos-foundry`), mode 0600."""
import json
import os
import tempfile
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Optional

from .errors import ConfigError, NotPairedError

ENV = "WEBOS_FOUNDRY_HOME"
FILE = "config.json"
NOT_PAIRED = "No TV is paired; run `wof pair --host <ip> --root-key <path>`"


def config_dir(override=None) -> Path:
    """`override` (CLI --config-dir) wins over the env var, which wins over ~/.config/webos-foundry."""
    if override:
        return Path(override).expanduser()
    return Path(os.environ.get(ENV) or "~/.config/webos-foundry").expanduser()


_dir = config_dir  # the classmethods below take a `config_dir` argument that shadows the function


@dataclass
class Config:
    tv_host: str = ""
    ssh_port: int = 22
    key_path: str = ""
    known_hosts_path: str = ""
    mac: Optional[str] = None
    broadcast: Optional[str] = None
    server_token: Optional[str] = None

    @classmethod
    def for_dir(cls, directory, **values) -> "Config":
        """A fresh config whose key/known_hosts live inside `directory`."""
        directory = Path(directory)
        values.setdefault("key_path", str(directory / "id_ed25519"))
        values.setdefault("known_hosts_path", str(directory / "known_hosts"))
        return cls(**values)

    @classmethod
    def load(cls, config_dir=None) -> "Config":
        path = _dir(config_dir) / FILE
        try:
            doc = json.loads(path.read_text())
        except FileNotFoundError:
            raise ConfigError("No config at %s; run `wof pair --host <ip> --root-key <path>`" % path) from None
        except (OSError, ValueError) as error:
            raise ConfigError("Cannot read %s: %s" % (path, error)) from None
        known = {f.name for f in fields(cls)}
        if not isinstance(doc, dict) or set(doc) - known:
            raise ConfigError("%s is malformed (unknown or non-object content)" % path)
        for name, value in doc.items():
            if name == "ssh_port":
                ok = type(value) is int
            else:
                ok = isinstance(value, str) or (value is None and name in ("mac", "broadcast", "server_token"))
            if not ok:
                raise ConfigError("%s: invalid value for %s" % (path, name))
        return cls(**doc)

    @classmethod
    def require(cls, config_dir=None) -> "Config":
        """The paired config, or NotPairedError pointing at `wof pair`."""
        if not (_dir(config_dir) / FILE).exists():
            raise NotPairedError(NOT_PAIRED)
        config = cls.load(config_dir)
        if not (config.tv_host and config.key_path and config.known_hosts_path):
            raise NotPairedError(NOT_PAIRED)
        return config

    def save(self, config_dir=None) -> Path:
        directory = _dir(config_dir)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / FILE
        # Temp file in the same directory (mkstemp creates it 0600) then rename: readers never see a partial file.
        descriptor, name = tempfile.mkstemp(prefix=".config-", dir=directory)
        try:
            with os.fdopen(descriptor, "w") as handle:
                json.dump(asdict(self), handle, indent=2)
                handle.write("\n")
            os.replace(name, path)
        except BaseException:
            try:
                os.unlink(name)
            except OSError:
                pass
            raise
        return path
