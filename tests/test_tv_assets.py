"""Offline checks for tv-assets/: syntax, metadata, and dispatch.sh run end-to-end against PATH shims.

dispatch.sh really executes here (under the local `sh`), but every TV-facing binary it calls
(luna-send, node, flock, ls-control) is a shim from a temp dir that logs its arguments and prints fixed
output, and its install paths are rewritten to temp dirs. Nothing here touches a TV or a network.
"""
import base64
import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

ASSETS = Path(__file__).resolve().parent.parent / "tv-assets"
SHELL = shutil.which("sh")
NODE = shutil.which("node")

INSTALL_FILES = ("status.sh", "details.js", "notify.js", "settings.js", "remote.js",
                 "process-image.js", "process-audio.js", "dispatch.sh")
JS_FILES = sorted(p.name for p in ASSETS.glob("*.js")) + ["overlay/overlay.js"]


def b64(data):
    return base64.b64encode(data if isinstance(data, bytes) else data.encode()).decode()


# ---------------------------------------------------------------- static checks

def test_asset_files_exist():
    for name in INSTALL_FILES + ("overlay/appinfo.json", "overlay/index.html", "overlay/overlay.js",
                                 "overlay/overlay.css", "overlay/icon.png", "vtcap/vtcap.c", "vtcap/build.sh"):
        assert (ASSETS / name).is_file(), name


@pytest.mark.skipif(SHELL is None, reason="no sh")
@pytest.mark.parametrize("name", ["dispatch.sh", "status.sh", "vtcap/build.sh"])
def test_sh_syntax(name):
    subprocess.run([SHELL, "-n", str(ASSETS / name)], check=True)


@pytest.mark.skipif(NODE is None, reason="no node")
@pytest.mark.parametrize("name", JS_FILES)
def test_node_syntax(name):
    subprocess.run([NODE, "--check", str(ASSETS / name)], check=True)


@pytest.mark.skipif(NODE is None, reason="no node")
def test_notify_pure_selftest():
    # --selftest only exercises decode()/card(); it never calls luna-send.
    out = subprocess.run([NODE, str(ASSETS / "notify.js"), "--selftest"], check=True, capture_output=True, text=True)
    assert "selftest ok" in out.stdout


def test_overlay_appinfo():
    info = json.loads((ASSETS / "overlay/appinfo.json").read_text())
    assert info["id"] == "dev.webosfoundry.overlay"
    assert info["vendor"] == "webOS Foundry contributors"
    assert info["title"] == "webOS Foundry Overlay"
    assert info["type"] == "web" and info["main"] == "index.html" and info["transparent"] is True
    assert (ASSETS / "overlay" / info["icon"]).read_bytes().startswith(b"\x89PNG")
    assert "dev.webosfoundry.overlay" in (ASSETS / "notify.js").read_text()


def test_no_personal_data():
    bad = re.compile(r"slopbro|192\.168\.8|6C:15:DB|LGTV|lg-c5|c5-|c5_|c5overlay|net\.slopbro", re.I)
    for path in ASSETS.rglob("*"):
        if path.is_file() and path.suffix in {".sh", ".js", ".json", ".html", ".css", ".c"}:
            assert not bad.search(path.read_text()), path
    # The only "C5" left is vtcap.c's wire magic, which capture.py reads (ARCHITECTURE section 9).
    assert "'C', '5', 'F', '1'" in (ASSETS / "vtcap/vtcap.c").read_text()


def test_install_whitelist_matches_contract():
    script = (ASSETS / "dispatch.sh").read_text()
    body = script[script.index("do_install() {"):]
    names = set(re.findall(r"[A-Za-z][\w-]*\.(?:sh|js)", body[:body.index("esac")]))
    assert names == set(INSTALL_FILES)


# ---------------------------------------------------------------- dispatch.sh against shims

LUNA = r"""#!/bin/sh
echo "luna-send $*" >> "$FAKE_LOG"
uri=$5; json=$6
[ "$1" = -n ] || { uri=$4; json=$5; }
case $uri in
  *capture/executeOneShot)
    p=${json#*\"path\":\"}; p=${p%%\"*}; printf 'IMGBYTES' > "$p"; echo '{"returnValue":true}' ;;
  *appInstallService/dev/install) echo '{"returnValue":true,"state":"installed"}' ;;
  *appInstallService/dev/remove) echo '{"returnValue":true,"state":"removed"}' ;;
  *getVolume) echo '{"returnValue":true,"volumeStatus":{"volume":10}}' ;;
  *) echo '{"returnValue":true}' ;;
esac
"""

NODE_SHIM = r"""#!/bin/sh
echo "node $*" >> "$FAKE_LOG"
case $1 in
  */process-*.js)
    ws=$2
    echo "input=$(cat "$ws"/input.* | wc -c)" >> "$FAKE_LOG"
    case $FAKE_FAIL in
      restore) echo "Restoration failed; keep $ws/restore.json: boom" >&2; exit 1 ;;
      plain) echo "Expected owned workspace" >&2; exit 1 ;;
    esac
    case $1 in *image*) out=captured.png ;; *) out=captured.wav ;; esac
    printf 'RESULTBYTES' > "$ws/$out"
    echo "{\"profile\":\"$3\",\"restored\":true}" ;;
  *) echo '{"returnValue":true}' ;;
esac
"""

# flock shim: skips option arguments, treats the next word as the lock file, then runs the command.
FLOCK = r"""#!/bin/sh
echo "flock $*" >> "$FAKE_LOG"
[ -n "$FAKE_BUSY" ] && exit 75
while :; do
  case $1 in -w | -E) shift 2 ;; -n) shift ;; *) break ;; esac
done
shift
exec "$@"
"""

LSCTL = "#!/bin/sh\necho \"ls-control $*\" >> \"$FAKE_LOG\"\n"


class Rig:
    def __init__(self, root):
        self.root = root
        self.tv = root / "webos-foundry"
        self.tmp = root / "tmp"
        self.vt = root / "vtcap"
        self.ls2 = root / "ls2"
        self.log = root / "calls.log"
        bin_dir = root / "bin"
        for d in (self.tv, self.tmp, self.vt.parent, bin_dir):
            d.mkdir(parents=True, exist_ok=True)
        for name, body in (("luna-send", LUNA), ("node", NODE_SHIM), ("flock", FLOCK), ("ls-control", LSCTL)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        # Retarget the path constants; everything else is the shipped script, byte for byte.
        text = (ASSETS / "dispatch.sh").read_text()
        for key, value in (("D", self.tv), ("LOCK", root / "lock"), ("TMP", self.tmp), ("VTDIR", self.vt),
                           ("LS2", self.ls2), ("LSCTL", bin_dir / "ls-control")):
            text, n = re.subn(rf"^{key}=.*$", f"{key}={value}", text, count=1, flags=re.M)
            assert n == 1, key
        self.script = root / "dispatch.sh"
        self.script.write_text(text)
        shutil.copy(ASSETS / "status.sh", self.tv / "status.sh")
        self.env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "FAKE_LOG": str(self.log)}

    def run(self, command, stdin=b"", **extra):
        env = {**self.env, **extra}
        if command is not None:
            env["SSH_ORIGINAL_COMMAND"] = command
        return subprocess.run([SHELL, str(self.script)], input=stdin, capture_output=True, env=env, timeout=30)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []


@pytest.fixture
def rig(tmp_path):
    if SHELL is None:
        pytest.skip("no sh")
    return Rig(tmp_path)


B = b64("hello")  # "aGVsbG8="
JSON_B64 = b64(json.dumps({"value": "on", "context": {"input": "hdmi1"}}))

# (request, substring that must appear in the shim call log)
GOOD = [
    ("details", "node {D}/details.js"),
    ("remote wake", "node {D}/remote.js wake"),
    ("remote power_off", "remote.js power_off"),
    ("remote volume_down", "remote.js volume_down"),
    ("remote hdmi 3", "remote.js hdmi 3"),
    ("settings-list", "settings.js list"),
    (f"settings-set aiPicture ai_Picture {JSON_B64}", f"settings.js set aiPicture ai_Picture {JSON_B64}"),
    (f"notify-toast {B}", f"notify.js toast {B}"),
    (f"notify-say {B}", f"notify.js say {B}"),
    (f"notify-say {B} 20", f"notify.js say {B} 20"),
    (f"notify-overlay {b64('{}')}", f"notify.js overlay {b64('{}')}"),
    ("idle-wait", "flock -w 25 -E 75"),
    ("screenshot 1920 1080 jpg", "capture/executeOneShot"),
    ("screenshot 960 540 png", '"format":"PNG","width":960,"height":540'),
]


def test_good_requests_dispatch(rig):
    for request, expect in GOOD:
        rig.log.write_text("")
        result = rig.run(request)
        assert result.returncode == 0, (request, result.stderr)
        assert expect.format(D=rig.tv) in "\n".join(rig.calls()), request


def test_verbs_that_take_the_lock_use_it(rig):
    for request in ("remote home", "settings-list", f"notify-say {B}"):
        rig.log.write_text("")
        assert rig.run(request).returncode == 0
        assert any(c.startswith("flock -w") for c in rig.calls()), request
    rig.log.write_text("")
    rig.run(f"notify-toast {B}")
    assert not any(c.startswith("flock") for c in rig.calls())


def test_busy_lock_is_reported(rig):
    result = rig.run("remote home", FAKE_BUSY="1")
    assert result.returncode == 75
    assert b"busy" in result.stderr


def test_status_is_four_docs_then_volume(rig):
    result = rig.run("status")
    assert result.returncode == 0
    out = result.stdout.decode()
    assert '"temperature_millicelsius":null' in out  # no /proc/thermalinfo on the test host
    head, _, volume = out.partition("\n@@@\n")
    assert json.loads(volume)["volumeStatus"]["volume"] == 10
    assert out.count("getPowerState") == 0 and "luna-send" in "\n".join(rig.calls())


def test_screenshot_streams_bytes_and_cleans_up(rig):
    result = rig.run("screenshot 1920 1080 png")
    assert result.stdout == b"IMGBYTES"
    assert list(rig.tmp.iterdir()) == []


def test_stream_start_execs_vtcap(rig):
    rig.vt.mkdir()
    exe = rig.vt / "vtcap"
    exe.write_text('#!/bin/sh\necho "vtcap $*"\n')
    exe.chmod(0o755)
    result = rig.run("stream-start 160 090 30 0005 2")
    assert result.stdout == b"vtcap -w 160 -h 90 -f 30 -t 5 -d 2\n"  # leading zeros stripped, never read as octal


@pytest.mark.parametrize("request_,image", [("process-image ai-picture-sr 1920 1080", True),
                                            ("process-audio clear-voice 12", False)])
def test_process_success_streams_metadata_then_bytes_and_cleans(rig, request_, image):
    result = rig.run(request_, stdin=b"UPLOAD" * 10)
    assert result.returncode == 0, result.stderr
    meta, _, payload = result.stdout.partition(b"\n")
    assert json.loads(meta)["restored"] is True and payload == b"RESULTBYTES"
    assert any("input=60" == c for c in rig.calls())
    assert any(c.startswith("flock -n -E 75") for c in rig.calls())
    assert list(rig.tmp.iterdir()) == []
    workspace_arg = [c for c in rig.calls() if c.startswith("node ")][0].split()[2]
    assert re.fullmatch(re.escape(str(rig.tmp)) + r"/webos-foundry-ai\.[A-Za-z0-9]+", workspace_arg)


def test_process_failures(rig):
    plain = rig.run("process-image standard 1920 1080", stdin=b"x", FAKE_FAIL="plain")
    assert plain.returncode == 1 and b"Expected owned workspace" in plain.stderr
    assert list(rig.tmp.iterdir()) == []  # validation failure: nothing to recover
    kept = rig.run("process-audio standard 3", stdin=b"x", FAKE_FAIL="restore")
    assert kept.returncode == 1 and b"workspace kept for recovery" in kept.stderr
    assert len(list(rig.tmp.iterdir())) == 1  # restoration failed: keep restore.json
    busy = rig.run("process-audio standard 3", stdin=b"x", FAKE_BUSY="1")
    assert busy.returncode == 75 and len(list(rig.tmp.iterdir())) == 1


def test_process_upload_cap(rig):
    result = rig.run("process-audio standard 3", stdin=b"\0" * (8 * 1024 * 1024 + 1))
    assert result.returncode == 1 and b"larger than" in result.stderr
    assert not any(c.startswith("node ") for c in rig.calls()) and list(rig.tmp.iterdir()) == []


def test_install_files(rig):
    for name in INSTALL_FILES:
        assert rig.run(f"install {name} {b64('payload ' + name)}").returncode == 0, name
        target = rig.tv / name
        assert target.read_text() == "payload " + name
        mode = stat.S_IMODE(target.stat().st_mode)
        assert mode == (0o755 if name.endswith(".sh") else 0o644), (name, oct(mode))
        assert not (rig.tv / (name + ".new")).exists()
    status = json.loads(rig.run("install-status").stdout)
    assert status["files"] == {name: True for name in INSTALL_FILES}
    assert status["vtcap"] is False


def test_install_overlay_and_vtcap_and_uninstall(rig):
    rig.run(f"install status.sh {b64('x')}")
    ok = rig.run(f"install-overlay {b64('IPKBYTES')}")
    assert ok.returncode == 0 and b"Overlay installed" in ok.stdout
    assert any('"ipkUrl":"' + str(rig.tmp) in c for c in rig.calls())
    assert list(rig.tmp.iterdir()) == []  # ipk removed afterwards
    assert rig.run("uninstall-overlay").returncode == 0
    assert any("appInstallService/dev/remove" in c and "dev.webosfoundry.overlay" in c for c in rig.calls())

    assert rig.run(f"install-vtcap {b64(b'ELF')}").returncode == 0
    assert (rig.vt / "vtcap").read_bytes() == b"ELF" and os.access(rig.vt / "vtcap", os.X_OK)
    role = json.loads((rig.ls2 / "roles.d/dev.webosfoundry.vtcap.json").read_text())
    manifest = json.loads((rig.ls2 / "manifests.d/dev.webosfoundry.vtcap.json").read_text())
    assert role["exeName"] == str(rig.vt / "vtcap") and manifest["id"] == "dev.webosfoundry.vtcap"
    assert manifest["roleFiles"] == [str(rig.ls2 / "roles.d/dev.webosfoundry.vtcap.json")]
    assert json.loads(rig.run("install-status").stdout)["vtcap"] is True
    assert any(c == "ls-control scan-volatile-dirs" for c in rig.calls())

    assert rig.run("uninstall-vtcap").returncode == 0
    assert not (rig.vt / "vtcap").exists() and not list(rig.ls2.glob("*/*.json"))

    result = rig.run("uninstall-all")
    assert result.returncode == 0 and b"authorized_keys" in result.stdout
    assert not rig.tv.exists()


# ---------------------------------------------------------------- rejection

ATTACKS = {
    "empty": "",
    "unknown verb": "ls",
    "unknown verb with args": "cat /etc/passwd",
    "status extra arg": "status now",
    "status substitution": "status $(touch PWNED)",
    "status backtick": "status `touch PWNED`",
    "status newline": "status\ntouch PWNED",
    "status semicolon": "status; touch PWNED",
    "status pipe": "status | sh",
    "trailing space": "status ",
    "leading space": " status",
    "double space": "remote  home",
    "details newline": "details\nid",
    "remote unknown action": "remote reboot",
    "remote hdmi out of range": "remote hdmi 5",
    "remote hdmi two digits": "remote hdmi 12",
    "remote hdmi missing": "remote hdmi",
    "remote substitution": "remote $(id)",
    "remote traversal": "remote ../../bin/sh",
    "remote newline": "remote home\nremote home",
    "settings-set bad category": f"settings-set 1abc key {JSON_B64}",
    "settings-set traversal": f"settings-set ../x key {JSON_B64}",
    "settings-set dash": f"settings-set a-b key {JSON_B64}",
    "settings-set substitution": "settings-set aiPicture ai_Picture $(id)",
    "settings-set newline": f"settings-set aiPicture ai_Picture {JSON_B64}\nid",
    "settings-set too long": "settings-set aiPicture ai_Picture " + "A" * 4001,
    "settings-set bad padding": "settings-set aiPicture ai_Picture QQ===",
    "settings-set padding in middle": "settings-set aiPicture ai_Picture QQ=Q",
    "toast empty": "notify-toast",
    "toast substitution": "notify-toast $(id)",
    "toast backtick": "notify-toast `id`",
    "toast newline": f"notify-toast {B}\nid",
    "toast too long": "notify-toast " + "A" * 401,
    "toast bad padding": "notify-toast QQ===",
    "toast url-safe base64": "notify-toast a-b_",
    "say volume three digits": f"notify-say {B} 123",
    "say volume letters": f"notify-say {B} 1a",
    "say volume substitution": f"notify-say {B} $(id)",
    "say extra arg": f"notify-say {B} 10 20",
    "overlay too long": "notify-overlay " + "A" * 8001,
    "overlay newline": f"notify-overlay {B}\nid",
    "screenshot bad format": "screenshot 1920 1080 gif",
    "screenshot traversal fmt": "screenshot 1920 1080 ../../x",
    "screenshot short number": "screenshot 9 1080 jpg",
    "screenshot odd width": "screenshot 1921 1080 jpg",
    "screenshot not 16:9": "screenshot 1920 1000 jpg",
    "screenshot substitution": "screenshot $(id) 1080 jpg",
    "screenshot newline": "screenshot 1920 1080 jpg\nid",
    "stream dump out of range": "stream-start 160 90 30 0 6",
    "stream fps too long": "stream-start 160 90 1000 0 2",
    "stream substitution": "stream-start 160 90 30 $(id) 2",
    "stream path in arg": "stream-start 160 90 30 0 2 /bin/sh",
    "image bad profile start": "process-image 1abc 1920 1080",
    "image profile traversal": "process-image ../../x 1920 1080",
    "image profile substitution": "process-image $(id) 1920 1080",
    "image profile semicolon": "process-image standard;id 1920 1080",
    "image newline": "process-image standard 1920 1080\nid",
    "image width 5 digits": "process-image standard 19200 1080",
    "audio seconds 3 digits": "process-audio standard 123",
    "audio substitution": "process-audio standard $(id)",
    "audio newline": "process-audio standard 3\nid",
    "idle-wait arg": "idle-wait now",
    "install unknown file": f"install evil.sh {B}",
    "install traversal": f"install ../../etc/passwd {B}",
    "install traversal suffix": f"install status.sh/../x {B}",
    "install absolute": f"install /etc/passwd {B}",
    "install substitution": "install status.sh $(id)",
    "install newline": f"install status.sh {B}\nid",
    "install missing payload": "install status.sh",
    "install-overlay substitution": "install-overlay $(id)",
    "install-overlay newline": f"install-overlay {B}\nid",
    "install-vtcap backtick": "install-vtcap `id`",
    "install-vtcap bad charset": "install-vtcap a-b",
    "install-status arg": "install-status x",
    "uninstall-all arg": "uninstall-all now",
    "uninstall-all substitution": "uninstall-all $(id)",
    "uninstall-vtcap newline": "uninstall-vtcap\nid",
}


@pytest.mark.parametrize("name", sorted(ATTACKS))
def test_rejects(rig, name):
    result = rig.run(ATTACKS[name])
    assert result.returncode == 64, (name, result.stdout, result.stderr)
    assert result.stderr.startswith(b"webos-foundry: ")
    assert rig.calls() == []  # nothing reached luna-send/node/flock
    assert not (rig.root / "PWNED").exists() and not (Path.cwd() / "PWNED").exists()
    assert list(rig.tmp.iterdir()) == [] and list(rig.tv.iterdir()) == [rig.tv / "status.sh"]


def test_rejects_unset_variable(rig):
    result = rig.run(None)
    assert result.returncode == 64


def test_every_verb_in_the_contract_has_a_branch():
    verbs = ("status details remote settings-list settings-set notify-toast notify-say notify-overlay screenshot "
             "stream-start process-image process-audio idle-wait install install-overlay uninstall-overlay "
             "install-vtcap uninstall-vtcap uninstall-all install-status").split()
    script = (ASSETS / "dispatch.sh").read_text()
    for verb in verbs:
        assert re.search(rf"^  {re.escape(verb)}\)$", script, re.M), verb
