"""Offline checks for tv-assets/: syntax, metadata, and dispatch.sh run end-to-end against PATH shims.

dispatch.sh really executes here (under the local `sh`), but every TV-facing binary it calls
(luna-send, node, flock, ls-control) is a shim from a temp dir that logs its arguments and prints fixed
output, and its install paths are rewritten to temp dirs. Nothing here touches a TV or a network.
"""
import base64
import hashlib
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
                 "process-image.js", "process-audio.js", "apps.js", "dispatch.sh")
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
        self.hooks = root / "init.d"
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
                           ("LS2", self.ls2), ("LSCTL", bin_dir / "ls-control"), ("HOOKDIR", self.hooks)):
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
    ("idle-wait", "flock -w 25 -E 75"),
    ("screenshot 1920 1080 jpg", "capture/executeOneShot"),
    ("screenshot 960 540 png", '"format":"PNG","width":960,"height":540'),
    ("app-list", "node {D}/apps.js list"),
    (f"app-install {B}", f"apps.js install {B}"),
    (f"app-uninstall {B}", f"apps.js uninstall {B}"),
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
        assert rig.run(f"install {name}", stdin=("payload " + name).encode()).returncode == 0, name
        target = rig.tv / name
        assert target.read_text() == "payload " + name
        mode = stat.S_IMODE(target.stat().st_mode)
        assert mode == (0o755 if name.endswith(".sh") else 0o644), (name, oct(mode))
        assert not (rig.tv / (name + ".new")).exists()
    status = json.loads(rig.run("install-status").stdout)
    assert status["files"] == {name: True for name in INSTALL_FILES}
    assert status["vtcap"] is False


def test_notify_overlay_reads_the_card_from_stdin_and_cleans_up(rig):
    card = b'{"root": {"type": "text", "text": "hi"}}'
    result = rig.run("notify-overlay", stdin=card)
    assert result.returncode == 0
    assert any(c.startswith("node {D}/notify.js overlay ".format(D=rig.tv)) for c in rig.calls())
    assert list(rig.tmp.iterdir()) == []  # the temp card file is removed afterward


def test_notify_overlay_with_no_stdin_payload_is_rejected(rig):
    result = rig.run("notify-overlay", stdin=b"")
    assert result.returncode != 0 and b"Upload must be" in result.stderr
    assert list(rig.tmp.iterdir()) == []


def test_install_overlay_and_vtcap_and_uninstall(rig):
    rig.run("install status.sh", stdin=b"x")
    ok = rig.run("install-overlay", stdin=b"IPKBYTES")
    assert ok.returncode == 0 and b"Overlay installed" in ok.stdout
    assert any('"ipkUrl":"' + str(rig.tmp) in c for c in rig.calls())
    assert list(rig.tmp.iterdir()) == []  # ipk removed afterwards
    assert rig.run("uninstall-overlay").returncode == 0
    assert any("appInstallService/dev/remove" in c and "dev.webosfoundry.overlay" in c for c in rig.calls())

    assert rig.run("install-vtcap", stdin=b"ELF").returncode == 0
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
    "overlay with inline payload": "notify-overlay " + "A" * 100,
    "overlay trailing newline": "notify-overlay\nid",
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
    "install unknown file": "install evil.sh",
    "install traversal": "install ../../etc/passwd",
    "install traversal suffix": "install status.sh/../x",
    "install absolute": "install /etc/passwd",
    "install substitution": "install status.sh $(id)",
    "install newline": "install status.sh\nid",
    "install-overlay substitution": "install-overlay $(id)",
    "install-overlay newline": "install-overlay\nid",
    "install-vtcap backtick": "install-vtcap `id`",
    "install-vtcap extra arg": "install-vtcap a-b",
    "install-status arg": "install-status x",
    "uninstall-all arg": "uninstall-all now",
    "uninstall-all substitution": "uninstall-all $(id)",
    "uninstall-vtcap newline": "uninstall-vtcap\nid",
    "app-list arg": "app-list now",
    "app-install substitution": "app-install $(id)",
    "app-install semicolon": f"app-install {B}; touch PWNED",
    "app-install backtick": "app-install `id`",
    "app-install newline": f"app-install {B}\nid",
    "app-install too long": "app-install " + "A" * 1001,
    "app-install bad padding": "app-install QQ===",
    "app-install extra arg": f"app-install {B} {B}",
    "app-install missing": "app-install",
    "app-uninstall too long": "app-uninstall " + "A" * 201,
    "app-uninstall substitution": "app-uninstall $(id)",
    "app-uninstall newline": f"app-uninstall {B}\nid",
    "tree traversal": "install-tree ../x/y put",
    "tree traversal middle": "install-tree a/../../x put",
    "tree traversal tail": "install-tree a/b/.. put",
    "tree absolute": "install-tree /etc/passwd put",
    "tree absolute dir": "install-tree /tmp/x/y put",
    "tree top-level file": "install-tree dispatch.sh put",
    "tree dotfile": "install-tree a/.profile put",
    "tree dot dir": "install-tree .ssh/authorized_keys put",
    "tree double slash": "install-tree a//b put",
    "tree trailing slash": "install-tree a/b/ put",
    "tree too deep": "install-tree " + "/".join("d" * 9) + " put",
    "tree too long": "install-tree " + "/".join(["d" * 40] * 6) + " put",
    "tree long component": "install-tree a/" + "b" * 65 + " put",
    "tree bad mode": "install-tree a/b exec",
    "tree substitution": "install-tree a/$(id) put",
    "tree semicolon": "install-tree a/b;touch put",
    "tree newline": "install-tree a/b put\nid",
    "tree extra arg": "install-tree a/b put a-b_c",
    "hook bad name": "install-hook rc.local",
    "hook name traversal": "install-hook webos-foundry-../x",
    "hook uppercase": "install-hook webos-foundry-Up",
    "hook extension": "install-hook webos-foundry-a.sh",
    "run-hook foreign": "run-hook sh start",
    "run-hook traversal": "run-hook ../../bin/sh start",
    "run-hook bad action": "run-hook webos-foundry-x restart",
    "run-hook substitution": "run-hook webos-foundry-x $(id)",
}


@pytest.mark.parametrize("name", sorted(ATTACKS))
def test_rejects(rig, name):
    result = rig.run(ATTACKS[name])
    assert result.returncode == 64, (name, result.stdout, result.stderr)
    assert result.stderr.startswith(b"webos-foundry: ")
    assert rig.calls() == []  # nothing reached luna-send/node/flock
    assert not (rig.root / "PWNED").exists() and not (Path.cwd() / "PWNED").exists()
    assert list(rig.tmp.iterdir()) == [] and list(rig.tv.iterdir()) == [rig.tv / "status.sh"]


def test_install_with_no_stdin_payload_is_rejected(rig):
    result = rig.run("install notify.js")
    assert result.returncode == 1 and b"Upload must be 1-" in result.stderr
    assert not (rig.tv / "notify.js").exists() and not (rig.tv / "notify.js.new").exists()


def test_install_tree_with_no_stdin_payload_is_rejected(rig):
    result = rig.run("install-tree a/b put")
    assert result.returncode == 1 and b"Upload chunk must be 1-" in result.stderr
    assert not (rig.tv / "a/b").exists() and not (rig.tv / "a/b.part").exists()


def test_install_hook_with_no_stdin_payload_is_rejected(rig):
    result = rig.run("install-hook webos-foundry-x")
    assert result.returncode == 1 and b"Upload must be 1-" in result.stderr
    assert not (rig.hooks / "webos-foundry-x").exists()


def test_rejects_unset_variable(rig):
    result = rig.run(None)
    assert result.returncode == 64


def test_every_verb_in_the_contract_has_a_branch():
    verbs = ("status details remote settings-list settings-set notify-toast notify-say notify-overlay screenshot "
             "stream-start process-image process-audio idle-wait install install-overlay uninstall-overlay "
             "install-vtcap uninstall-vtcap uninstall-all install-status app-list app-install app-uninstall "
             "install-tree install-hook run-hook").split()
    script = (ASSETS / "dispatch.sh").read_text()
    for verb in verbs:
        assert re.search(rf"^  {re.escape(verb)}\)$", script, re.M), verb


# ---------------------------------------------------------------- directory push and boot hooks

def snapshot(root):
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))


def test_install_tree_writes_nested_files_under_the_root(rig):
    for path, text in (("tv-server/server.js", "js"), ("tv-server/web/css/app.css", "css"), ("a_b/c-d/e.f.txt", "txt")):
        assert rig.run(f"install-tree {path} put", stdin=text.encode()).returncode == 0, path
        assert (rig.tv / path).read_text() == text and not (rig.tv / (path + ".part")).exists()
        assert stat.S_IMODE((rig.tv / path).stat().st_mode) == 0o644
    assert rig.run("install-tree tv-server/server.js put", stdin=b"new").returncode == 0  # overwrite, atomically
    assert (rig.tv / "tv-server/server.js").read_text() == "new"


def test_install_tree_chunks_append_and_only_the_last_publishes(rig):
    assert rig.run("install-tree tv-server/big.bin begin", stdin=b"AAA").returncode == 0
    assert not (rig.tv / "tv-server/big.bin").exists()  # nothing visible until the end chunk
    assert rig.run("install-tree tv-server/big.bin more", stdin=b"BBB").returncode == 0
    assert rig.run("install-tree tv-server/big.bin end", stdin=b"CC").returncode == 0
    assert (rig.tv / "tv-server/big.bin").read_bytes() == b"AAABBBCC" and not (rig.tv / "tv-server/big.bin.part").exists()
    assert rig.run("install-tree tv-server/x more", stdin=b"a").returncode == 1  # no begin: refused, nothing written
    assert rig.run("install-tree tv-server/x end", stdin=b"a").returncode == 1
    assert not (rig.tv / "tv-server/x").exists()
    assert rig.run("install-tree tv-server put", stdin=b"a").returncode == 64  # one component: not a file under a directory


def test_install_tree_never_writes_outside_the_root_or_over_a_directory(rig):
    (rig.tv / "tv-server").mkdir()
    before = snapshot(rig.root)
    escapes = ["../x/y", "a/../../escape", "a/b/..", "/etc/x/y", "/tmp/webos/y", "a/.x", ".ssh/key", "a//b", "a/b/",
               "dispatch.sh", "a/b;touch/c", "a/$(touch PWNED)/b", "a/b c/d", "a/\\..\\x"]
    for path in escapes:
        result = rig.run(f"install-tree {path} put", stdin=b"x")
        assert result.returncode == 64, path
    assert snapshot(rig.root) == before  # not one file or directory created anywhere
    assert not (rig.root / "PWNED").exists()
    clash = rig.run("install-tree tv-server put", stdin=b"x")  # a path that is an existing directory is refused, not mv'd into
    assert clash.returncode == 64
    (rig.tv / "tv-server/web").mkdir()
    assert rig.run("install-tree tv-server/web put", stdin=b"x").returncode == 1
    assert snapshot(rig.root) == before + ["webos-foundry/tv-server/web"]


HOOK = "#!/bin/sh\necho \"hook $1\" >> \"$FAKE_LOG\"\necho \"hook says $1\"\nsleep 30 &\n"  # sleep: a daemon holding stdout


def test_hook_install_run_and_uninstall(rig):
    name = "webos-foundry-tv-server"
    assert rig.run(f"install-hook {name}", stdin=HOOK.encode()).returncode == 0
    hook = rig.hooks / name
    assert hook.read_text() == HOOK and os.access(hook, os.X_OK) and not list(rig.hooks.glob(".*new"))
    started = rig.run(f"run-hook {name} start")  # must return even though the hook leaves a process on stdout
    assert started.returncode == 0 and b"hook says start" in started.stdout
    assert "hook start" in rig.calls() and list(rig.tmp.iterdir()) == []
    assert rig.run("run-hook webos-foundry-missing start").returncode == 1
    other = rig.hooks / "someone-elses-hook"
    other.write_text("#!/bin/sh\n")
    removed = rig.run("uninstall-all")
    assert removed.returncode == 0 and not hook.exists() and other.exists()  # only webos-foundry-* hooks are touched
    assert "hook stop" in rig.calls()


# ---------------------------------------------------------------- apps.js against fake curl + luna-send

FAKE_CURL = r"""#!/bin/sh
# args: --fail --location --silent --show-error --max-time N --output DEST -- URL
echo "curl $*" >> "$FAKE_LOG"
dest=""; prev=""
for a in "$@"; do [ "$prev" = "--output" ] && dest="$a"; prev="$a"; done
case $FAKE_SCENARIO in
  download-fail) echo "curl: (22) The requested URL returned error" >&2; exit 22 ;;
  empty) : > "$dest" ;;
  *) printf '%s' "$FAKE_IPK_BYTES" > "$dest" ;;
esac
"""

FAKE_LUNA = r"""#!/bin/sh
# args: [-n 1] -w MS [-i] URI JSON ; scenario from FAKE_SCENARIO
echo "luna-send $*" >> "$FAKE_LOG"
case $FAKE_SCENARIO in
  ok)
    echo '{"returnValue":true,"state":"downloading","progress":10}'
    echo '{"returnValue":true,"state":"installing"}'
    echo '{"returnValue":true,"state":"installed"}'
    exec sleep 30 ;;
  refused)
    echo '{"returnValue":true,"state":"downloading","progress":10}'
    echo '{"returnValue":false,"errorText":"Install refused"}'
    exec sleep 30 ;;
  hang)
    echo '{"returnValue":true,"state":"downloading","progress":10}'
    exec sleep 30 ;;
  dies)
    echo '{"returnValue":true,"state":"downloading","progress":10}' ;;
  plain)
    echo '{"returnValue":true,"state":"removed"}'
    exec sleep 30 ;;
  list)
    echo '{"returnValue":true,"apps":[{"id":"com.webos.app.home","title":"Home","removable":false},{"id":"com.example.game","title":"Game","icon":"/i.png","version":"1.2.3","removable":true,"extra":1}]}' ;;
  listfail)
    echo '{"returnValue":false}' ;;
esac
"""

IPK_BYTES = "IPKDATA"
SHA = hashlib.sha256(IPK_BYTES.encode()).hexdigest()
WRONG_SHA = "ab" * 32


@pytest.fixture
def apps_rig(tmp_path):
    if NODE is None:
        pytest.skip("no node")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "luna-send").write_text(FAKE_LUNA)
    (bin_dir / "luna-send").chmod(0o755)
    (bin_dir / "curl").write_text(FAKE_CURL)
    (bin_dir / "curl").chmod(0o755)
    log = tmp_path / "calls.log"

    def run(*args, scenario="ok", timeout_ms=None, ipk_bytes=IPK_BYTES):
        env = {"PATH": f"{bin_dir}:{Path(NODE).parent}:/usr/bin:/bin", "FAKE_LOG": str(log),
               "FAKE_SCENARIO": scenario, "FAKE_IPK_BYTES": ipk_bytes, "TMPDIR": str(tmp_path)}
        if timeout_ms:
            env["WOF_APPS_TIMEOUT_MS"] = str(timeout_ms)
            env["WOF_APPS_DOWNLOAD_TIMEOUT_MS"] = str(timeout_ms)
        return subprocess.run([NODE, str(ASSETS / "apps.js"), *args], capture_output=True, text=True, env=env,
                              timeout=20, cwd=tmp_path)

    run.calls = lambda: log.read_text().splitlines() if log.exists() else []
    run.root = tmp_path
    return run


def request(**fields):
    return b64(json.dumps(fields))


def test_apps_install_downloads_then_streams_until_installed(apps_rig):
    result = apps_rig("install", request(url="https://example.com/a.ipk", sha256=SHA))
    assert result.returncode == 0 and json.loads(result.stdout) == {"returnValue": True, "state": "installed"}
    assert result.stdout.count("\n") == 1  # only the terminal line, none of the progress
    calls = apps_rig.calls()
    curl_call, luna_call = calls[0], calls[1]
    assert curl_call.startswith("curl ") and "-- https://example.com/a.ipk" in curl_call
    assert "-i luna://com.webos.appInstallService/dev/install " in luna_call
    body = json.loads(luna_call.split("/install ", 1)[1])
    assert body["id"] == "com.ares.defaultName" and body["subscribe"] is True
    assert body["ipkUrl"].endswith(".ipk") and body["ipkUrl"] != "https://example.com/a.ipk"  # a local path, not the URL
    assert not Path(body["ipkUrl"]).exists()  # deleted after the attempt, success or failure


def test_apps_install_without_hash_skips_verification(apps_rig):
    assert apps_rig("install", request(url="http://tv.example:8765/uploads/x.ipk")).returncode == 0


def test_apps_install_hash_mismatch_never_reaches_luna(apps_rig):
    result = apps_rig("install", request(url="https://example.com/a.ipk", sha256=WRONG_SHA))
    assert result.returncode == 1 and "sha256" in result.stderr.lower()
    assert all("luna-send" not in c for c in apps_rig.calls())  # curl ran, luna-send never did


def test_apps_install_download_failure(apps_rig):
    result = apps_rig("install", request(url="https://example.com/a.ipk"), scenario="download-fail")
    assert result.returncode == 1 and "Download failed" in result.stderr
    assert all("luna-send" not in c for c in apps_rig.calls())


def test_apps_install_empty_download_is_rejected(apps_rig):
    result = apps_rig("install", request(url="https://example.com/a.ipk"), scenario="empty")
    assert result.returncode == 1 and "empty" in result.stderr.lower()


def test_apps_install_failure_and_timeout(apps_rig):
    refused = apps_rig("install", request(url="https://example.com/a.ipk"), scenario="refused")
    assert refused.returncode == 1 and json.loads(refused.stdout)["errorText"] == "Install refused"
    assert "Install refused" in refused.stderr
    hang = apps_rig("install", request(url="https://example.com/a.ipk"), scenario="hang", timeout_ms=400)
    assert hang.returncode == 1 and "install timed out" in hang.stderr and hang.stdout == ""
    dies = apps_rig("install", request(url="https://example.com/a.ipk"), scenario="dies")
    assert dies.returncode == 1 and "without finishing" in dies.stderr


@pytest.mark.parametrize("name,payload", [
    ("not base64", "a b!"),
    ("not json", b64("nope")),
    ("array", b64("[1]")),
    ("url missing", request(sha256=SHA)),
    ("ftp scheme", request(url="ftp://example.com/a.ipk")),
    ("file scheme", request(url="file:///etc/passwd")),
    ("whitespace in url", request(url="http://example.com/a b.ipk")),
    ("quote in url", request(url='http://example.com/a"b')),
    ("newline in url", request(url="http://example.com/a\nb")),
    ("oversized url", request(url="http://example.com/" + "a" * 482)),
    ("url not a string", request(url=["http://example.com/a"])),
    ("sha too short", request(url="http://e.com/a", sha256="ab" * 31)),
    ("sha uppercase", request(url="http://e.com/a", sha256="AB" * 32)),
    ("sha not hex", request(url="http://e.com/a", sha256="zz" * 32)),
    ("sha with prefix", request(url="http://e.com/a", sha256="sha256:" + SHA)),
    ("extra field", request(url="http://e.com/a", ipkHash="x")),
])
def test_apps_install_rejects_bad_requests_before_curl(apps_rig, name, payload):
    result = apps_rig("install", payload)
    assert result.returncode == 3 and result.stderr and result.stdout == "", name
    assert apps_rig.calls() == []


def test_apps_install_url_is_a_curl_argument_never_a_shell_command(apps_rig):
    url = "http://example.com/$(touch${IFS}PWNED);touch${IFS}PWNED&|x.ipk"
    assert apps_rig("install", request(url=url)).returncode == 0
    assert ("-- " + url) in apps_rig.calls()[0]  # argv, not shell-interpolated: curl receives it as inert data
    assert not (apps_rig.root / "PWNED").exists()


def test_apps_uninstall(apps_rig):
    ok = apps_rig("uninstall", b64("com.example.game"), scenario="plain")
    assert ok.returncode == 0 and json.loads(ok.stdout) == {"returnValue": True, "state": "removed"}
    assert json.loads(apps_rig.calls()[0].split("/remove ", 1)[1]) == {"id": "com.example.game", "subscribe": True}
    refused = apps_rig("uninstall", b64("com.example.game"), scenario="refused")
    assert refused.returncode == 1 and "uninstall failed" in refused.stderr
    hang = apps_rig("uninstall", b64("com.example.game"), scenario="hang", timeout_ms=400)
    assert hang.returncode == 1 and "uninstall timed out" in hang.stderr


@pytest.mark.parametrize("app_id", ["", "../x", "a b", "a;id", "$(id)", "-rf", ".hidden", "a" * 101, "a\nb"])
def test_apps_uninstall_rejects_bad_ids(apps_rig, app_id):
    result = apps_rig("uninstall", b64(app_id) if app_id else "")
    assert result.returncode == 3 and apps_rig.calls() == []


def test_apps_list_keeps_only_removable_apps(apps_rig):
    result = apps_rig("list", scenario="list")
    assert result.returncode == 0
    assert json.loads(result.stdout) == [{"id": "com.example.game", "title": "Game", "icon": "/i.png",
                                         "version": "1.2.3", "removable": True}]
    assert "luna://com.webos.applicationManager/listApps" in apps_rig.calls()[0]
    assert apps_rig("list", scenario="listfail").returncode == 1



def test_apps_usage_errors(apps_rig):
    assert apps_rig().returncode == 3 and apps_rig("nope").returncode == 3


class RigTransport:
    """Transport whose `run` executes the real dispatch.sh in the rig, so Python's chunking meets the shell's checks."""

    def __init__(self, rig):
        self.rig = rig

    def run(self, command, data=b"", timeout=20):
        result = self.rig.run(command, stdin=data)
        if result.returncode != 0:
            from webos_foundry.errors import TransportError
            raise TransportError(result.stderr.decode())
        return result.stdout


def test_python_directory_push_roundtrips_through_dispatch_sh(rig, tmp_path):
    from webos_foundry import install
    big = bytes(range(256)) * 1100  # several chunks, binary
    local = tmp_path / "local"
    files = {"server.js": b"// server\n", "web/index.html": b"<html>", "web/css/app.css": b"a{}", "web/js/big.bin": big,
             "web/fonts/x-1_2.woff2": b"\0\1\2", "config.json": b"{}", ".hidden": b"x"}
    for name, data in files.items():
        (local / name).parent.mkdir(parents=True, exist_ok=True)
        (local / name).write_bytes(data)
    pushed = install.push_tree(RigTransport(rig), local, "tv-server", skip=("config.json",))
    assert len(pushed) == 5
    for name, data in files.items():
        target = rig.tv / "tv-server" / name
        if name in ("config.json", ".hidden"):
            assert not target.exists()
        else:
            assert target.read_bytes() == data, name
    assert not list(rig.tv.rglob("*.part"))
    assert sorted(p.name for p in rig.tv.iterdir()) == ["status.sh", "tv-server"]  # nothing outside the tv-server subtree


def test_python_hook_push_roundtrips_through_dispatch_sh(rig):
    from webos_foundry import dispatcher, install
    transport = RigTransport(rig)
    transport.run(dispatcher.build_install_hook(install.TV_SERVER_HOOK), data=HOOK.encode())
    out = transport.run(dispatcher.build_run_hook(install.TV_SERVER_HOOK, "start"))
    assert out == b"hook says start\n" and (rig.hooks / install.TV_SERVER_HOOK).read_text() == HOOK
