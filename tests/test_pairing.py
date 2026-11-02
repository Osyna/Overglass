import re
import shutil
import stat
import subprocess

import pytest

from tests.fakes import FakeTransport, make_assets
from webos_foundry import dispatcher, pairing, transport
from webos_foundry.config import Config
from webos_foundry.errors import TransportError, TvBusyError, ValidationError

needs_keygen = pytest.mark.skipif(shutil.which("ssh-keygen") is None, reason="ssh-keygen not installed")
LINE = re.compile(r'command="sh /var/lib/webosbrew/webos-foundry/dispatch.sh",no-port-forwarding,no-agent-forwarding,'
                  r'no-X11-forwarding,no-pty,restrict ssh-ed25519 [A-Za-z0-9+/=]+ wof@[A-Za-z0-9._-]+')


@pytest.fixture
def env(monkeypatch, tmp_path):
    assets = make_assets(tmp_path / "assets")
    monkeypatch.setenv("WEBOS_FOUNDRY_ASSETS", str(assets))
    root_key = tmp_path / "secret-dir" / "tv_root_key"
    root_key.parent.mkdir()
    root_key.write_text("PRIVATE KEY BODY")
    return assets, root_key, tmp_path / "cfg"


def restricted():
    return FakeTransport({"install": b"", "install-overlay": b"", "install-vtcap": b""})


@needs_keygen
def test_pair_sequence_and_root_key_never_leaks(env):
    assets, root_key, cfg = env
    root = FakeTransport({pairing.PUSH_DISPATCHER: b"", pairing.APPEND_KEY: b""})
    new = restricted()
    config = pairing.pair("192.168.1.50", str(root_key), port=2222, config_dir=cfg, root=root,
                          transport_factory=lambda c: new)

    # Root connection: push dispatcher, then append exactly one restricted line; nothing else.
    assert root.commands == [pairing.PUSH_DISPATCHER, pairing.APPEND_KEY]
    assert root.calls[0].data == (assets / "dispatch.sh").read_bytes()
    line = root.calls[1].data.decode()
    assert line.endswith("\n") and LINE.fullmatch(line.strip())
    public = subprocess.run(["ssh-keygen", "-y", "-f", str(cfg / "id_ed25519")], capture_output=True, check=True).stdout.split()
    assert public[1].decode() in line
    assert "> " + pairing.AUTHORIZED_KEYS not in pairing.APPEND_KEY.replace(">> ", "")  # appends, never overwrites

    # Saved config: dedicated key, pinned host, generated token, mode 0600; reloadable.
    assert config == Config.load(cfg)
    assert (config.tv_host, config.ssh_port) == ("192.168.1.50", 2222)
    assert config.key_path == str(cfg / "id_ed25519") and config.known_hosts_path == str(cfg / "known_hosts")
    assert len(config.server_token) >= 32
    assert stat.S_IMODE((cfg / "config.json").stat().st_mode) == 0o600
    assert stat.S_IMODE((cfg / "id_ed25519").stat().st_mode) == 0o600

    # The restricted key then installs the assets (dispatch.sh last, then overlay); the root transport did not.
    assert new.commands[:8] and [c.split()[1] for c in new.commands[:8]] == [n for n in dispatcher.INSTALL_FILES if n != "dispatch.sh"] + ["dispatch.sh"]
    assert new.commands[8].startswith("install-overlay ")

    # The root key path/contents appear nowhere: config dir files, restricted calls, root-side data.
    secrets = [str(root_key), root_key.name, "secret-dir", "PRIVATE KEY BODY"]
    for path in cfg.rglob("*"):
        if path.is_file():
            blob = path.read_bytes() if path.name != "id_ed25519" else b""
            assert not any(secret.encode() in blob for secret in secrets), path
    for call in new.calls + root.calls:
        assert not any(secret in call.command or secret.encode() in call.data for secret in secrets)


@needs_keygen
def test_repair_reuses_key_and_keeps_user_settings(env):
    _, root_key, cfg = env
    first = pairing.pair("192.168.1.50", str(root_key), config_dir=cfg, root=FakeTransport({pairing.PUSH_DISPATCHER: b"", pairing.APPEND_KEY: b""}),
                         transport_factory=lambda c: restricted())
    before = (cfg / "id_ed25519").read_bytes()
    first.mac = "AA:BB:CC:DD:EE:FF"
    first.save(cfg)
    second = pairing.pair("192.168.1.60", str(root_key), config_dir=cfg, root=FakeTransport({pairing.PUSH_DISPATCHER: b"", pairing.APPEND_KEY: b""}),
                          transport_factory=lambda c: restricted())
    assert (cfg / "id_ed25519").read_bytes() == before
    assert second.tv_host == "192.168.1.60" and second.mac == "AA:BB:CC:DD:EE:FF" and second.server_token == first.server_token


@needs_keygen
def test_root_failure_saves_nothing(env):
    _, root_key, cfg = env
    root = FakeTransport({pairing.PUSH_DISPATCHER: TransportError("Permission denied")})
    with pytest.raises(TransportError, match="Permission denied"):
        pairing.pair("192.168.1.50", str(root_key), config_dir=cfg, root=root, transport_factory=lambda c: restricted())
    assert not (cfg / "config.json").exists()


@pytest.mark.parametrize("host", ["", "-oProxyCommand=x", "a b", "a;b", "host\n"])
def test_bad_host(env, host):
    _, root_key, cfg = env
    with pytest.raises(ValidationError):
        pairing.pair(host, str(root_key), config_dir=cfg)


@pytest.mark.parametrize("port", [0, 65536, "22", True])
def test_bad_port(env, port):
    _, root_key, cfg = env
    with pytest.raises(ValidationError):
        pairing.pair("192.168.1.50", str(root_key), port=port, config_dir=cfg)


def test_missing_root_key_and_missing_keygen(env, monkeypatch):
    _, root_key, cfg = env
    with pytest.raises(ValidationError, match="not found"):
        pairing.pair("192.168.1.50", str(root_key) + ".nope", config_dir=cfg)
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="ssh-keygen"):
        pairing.pair("192.168.1.50", str(root_key), config_dir=cfg, root=FakeTransport())


def test_authorized_line_format_and_rejections():
    line = pairing.authorized_line("ssh-ed25519 AAAAC3Nza+/= comment")
    assert LINE.fullmatch(line)
    for bad in ("", "ssh-rsa AAAA", "ssh-ed25519", "ssh-ed25519 AA AA\nAA", "ssh-ed25519 A!A"):
        with pytest.raises(ValidationError):
            pairing.authorized_line(bad)


def test_root_transport_pins_host_key_on_first_use_only(monkeypatch):
    seen = []
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: seen.append((argv, kw)) or subprocess.CompletedProcess(argv, 0, b"ok", b""))
    out = pairing.RootTransport("192.168.1.50", 22, "/k/root", "/k/known").run("true", b"in", 9)
    argv, kw = seen[0]
    assert out == b"ok" and "StrictHostKeyChecking=accept-new" in argv and "/k/root" in argv and kw["input"] == b"in"
    with pytest.raises(TransportError):
        pairing.RootTransport("h", 22, "k", "kh").run_streaming("x")


# --- SSHTransport (argv only; subprocess is stubbed, no connection is ever made) ---

CONFIG = Config(tv_host="192.168.1.50", ssh_port=2200, key_path="/c/id_ed25519", known_hosts_path="/c/known_hosts")


def fake_run(monkeypatch, returncode=0, stdout=b"out", stderr=b"", error=None):
    seen = []

    def run(argv, **kw):
        seen.append((argv, kw))
        if error:
            raise error
        return subprocess.CompletedProcess(argv, returncode, stdout, stderr)

    monkeypatch.setattr(subprocess, "run", run)
    return seen


def test_ssh_transport_argv_and_data(monkeypatch):
    seen = fake_run(monkeypatch)
    assert transport.SSHTransport(CONFIG).run("status", b"payload", timeout=7) == b"out"
    argv, kw = seen[0]
    assert argv[0] == "ssh" and argv[-2:] == ["root@192.168.1.50", "status"]
    options = [argv[i + 1] for i, a in enumerate(argv) if a == "-o"]
    assert options == ["IdentitiesOnly=yes", "BatchMode=yes", "StrictHostKeyChecking=yes",
                       "UserKnownHostsFile=/c/known_hosts", "WarnWeakCrypto=no", "ClearAllForwardings=yes", "ConnectTimeout=5"]
    assert argv[argv.index("-i") + 1] == "/c/id_ed25519" and argv[argv.index("-p") + 1] == "2200" and "-T" in argv
    assert kw["input"] == b"payload" and kw["timeout"] == 7 and kw["capture_output"] is True


def test_ssh_transport_error_mapping(monkeypatch):
    fake_run(monkeypatch, returncode=3, stderr=b"Capture failed\n")
    with pytest.raises(TransportError, match="Capture failed") as info:
        transport.SSHTransport(CONFIG).run("status")
    assert not isinstance(info.value, TvBusyError)
    fake_run(monkeypatch, returncode=3, stderr=b"")
    with pytest.raises(TransportError, match="TV SSH command failed"):
        transport.SSHTransport(CONFIG).run("status")
    fake_run(monkeypatch, returncode=75, stderr=b"TV is busy with AI processing or another change; try again shortly.")
    with pytest.raises(TvBusyError):
        transport.SSHTransport(CONFIG).run("process-audio x 1")
    fake_run(monkeypatch, error=subprocess.TimeoutExpired("ssh", 5))
    with pytest.raises(TransportError, match="did not answer within 5 s"):
        transport.SSHTransport(CONFIG).run("status", timeout=5)
    fake_run(monkeypatch, error=FileNotFoundError("ssh"))
    with pytest.raises(TransportError, match="Cannot run ssh"):
        transport.SSHTransport(CONFIG).run("status")


def test_ssh_transport_streaming_uses_popen_with_stdout_pipe(monkeypatch):
    seen = []
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **kw: seen.append((argv, kw)) or "popen")
    assert transport.SSHTransport(CONFIG).run_streaming("stream-start 160 90 30 0 2") == "popen"
    argv, kw = seen[0]
    assert argv[-1] == "stream-start 160 90 30 0 2" and kw["stdout"] == subprocess.PIPE and kw["stdin"] == subprocess.DEVNULL


def test_every_dispatcher_verb_is_a_single_ssh_argument(monkeypatch):
    seen = fake_run(monkeypatch)
    command = dispatcher.build_notify_say("QUJD", 15)
    transport.SSHTransport(CONFIG).run(command)
    assert seen[0][0][-1] == command
