"""Push, refresh and remove the TV-side assets over the dedicated (restricted) key.

`tv-assets/` (and the optional on-TV server in `tv-server/`) live at the repository root, not inside the package,
so a plain checkout or editable install works and a wheel does not carry them yet. Set WEBOS_FOUNDRY_ASSETS /
WEBOS_FOUNDRY_TV_SERVER / WEBOS_FOUNDRY_WEB to point at other copies; moving them into package data is a
packaging follow-up.

On-TV server layout (ARCHITECTURE.md §10.4), what `install(..., tv_server=True)` pushes:
  tv-server/<rel>          -> /var/lib/webosbrew/webos-foundry/tv-server/<rel>   (every file but config.json and the hook)
  web/<rel>                -> /var/lib/webosbrew/webos-foundry/tv-server/web/<rel>
  tv-server/init.d-hook.sh -> /var/lib/webosbrew/init.d/webos-foundry-tv-server   (mode 755), then run with `start`
The hook takes `start` (default; re-entrant) or `stop`; the TV's own config.json (token) is never overwritten.
"""
import io
import json
import os
import tarfile
import time
from pathlib import Path

from . import dispatcher
from .dispatcher import INSTALL_FILES
from .errors import ValidationError

ASSETS_ENV = "WEBOS_FOUNDRY_ASSETS"
TV_SERVER_ENV = "WEBOS_FOUNDRY_TV_SERVER"
WEB_ENV = "WEBOS_FOUNDRY_WEB"
TV_SERVER_DIR = "tv-server"  # under REMOTE_DIR on the TV
TV_SERVER_HOOK_SOURCE = "init.d-hook.sh"
TV_SERVER_HOOK = "webos-foundry-tv-server"
TV_SERVER_KEEP_REMOTE = ("config.json",)  # TV-owned state: never pushed
VTCAP_MODES = ("auto", "yes", "no")
# Payload is the SSH command's stdin, not a command argument; dispatch.sh enforces the same caps server-side.
FILE_MAX = 2_097_152  # raw bytes, one whole-file install/overlay/vtcap/hook upload
CHUNK = 4_194_304  # raw bytes per install-tree chunk
AUTHORIZED_KEYS_HINT = ("The restricted key line in /home/root/.ssh/authorized_keys (the one starting with "
                        "command=\"sh /var/lib/webosbrew/webos-foundry/dispatch.sh\") is left in place; "
                        "delete it by hand to finish removing webOS Foundry.")


def _repo_dir(name, env, label):
    path = Path(os.environ.get(env) or Path(__file__).resolve().parent.parent / name)
    if not path.is_dir():
        raise FileNotFoundError("%s not found at %s (set %s)" % (label, path, env))
    return path


def assets_dir() -> Path:
    return _repo_dir("tv-assets", ASSETS_ENV, "TV assets")


def tv_server_dir() -> Path:
    return _repo_dir(TV_SERVER_DIR, TV_SERVER_ENV, "TV server files")


def web_dir() -> Path:
    return _repo_dir("web", WEB_ENV, "Web UI files")


def _checked(data, cap=FILE_MAX):
    """Fail fast, before the SSH round trip, on a file dispatch.sh would reject anyway."""
    if not data or len(data) > cap:
        raise ValidationError("File must be 1-%d bytes" % cap)
    return data


def _tar_gz(entries):
    """entries: list of (path, bytes or None for a directory)."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz", format=tarfile.GNU_FORMAT) as tar:
        for name, data in entries:
            item = tarfile.TarInfo(name)
            item.mtime, item.uid, item.gid, item.uname, item.gname = int(time.time()), 0, 0, "root", "root"
            if data is None:
                item.type, item.mode = tarfile.DIRTYPE, 0o755
                tar.addfile(item)
            else:
                item.size, item.mode = len(data), 0o644
                tar.addfile(item, io.BytesIO(data))
    return out.getvalue()


def _ar(members):
    out = [b"!<arch>\n"]
    for name, data in members:
        header = b"%-16s%-12d%-6d%-6d%-8s%-10d`\n" % (name.encode(), int(time.time()), 0, 0, b"100644", len(data))
        out += [header, data, b"\n" if len(data) % 2 else b""]
    return b"".join(out)


def package_overlay(app_dir=None) -> bytes:
    """The overlay web app as a webOS IPK (ar archive of debian-binary, control.tar.gz, data.tar.gz)."""
    app_dir = Path(app_dir) if app_dir else assets_dir() / "overlay"
    info = json.loads((app_dir / "appinfo.json").read_text())
    app, version = info["id"], info["version"]
    files = sorted(p for p in app_dir.iterdir() if p.is_file())
    root = "./usr/palm/applications/" + app + "/"
    package_info = json.dumps({"app": app, "id": app, "loc_name": info["title"], "package_format_version": 2,
                               "vendor": info["vendor"], "version": version}, indent=2).encode()
    data = _tar_gz([("./usr", None), ("./usr/palm", None), ("./usr/palm/applications", None), (root, None)]
                   + [(root + p.name, p.read_bytes()) for p in files]
                   + [("./usr/palm/packages", None), ("./usr/palm/packages/" + app, None),
                      ("./usr/palm/packages/" + app + "/packageinfo.json", package_info)])
    size = sum(p.stat().st_size for p in files) + len(package_info)
    control = ("Package: %s\nVersion: %s\nSection: misc\nPriority: optional\nArchitecture: all\n"
               "Installed-Size: %d\nMaintainer: %s\nDescription: %s\nwebOS-Package-Format-Version: 2\n"
               "webOS-Packager-Version: 1.0.0\n" % (app, version, size, info["vendor"], info["title"])).encode()
    return _ar([("debian-binary", b"2.0\n"), ("control.tar.gz", _tar_gz([("./control", control)])),
                ("data.tar.gz", data)])


def _push_files(transport):
    root = assets_dir()
    # dispatch.sh last: the grammar only changes once every script it can run is in place.
    names = [n for n in INSTALL_FILES if n != "dispatch.sh"] + ["dispatch.sh"]
    for name in names:
        transport.run(dispatcher.build_install(name), data=_checked((root / name).read_bytes()), timeout=60)
    return list(names)


def push_tree(transport, local_dir, remote_prefix, *, skip=()) -> list:
    """Push every regular file under `local_dir` to <REMOTE_DIR>/<remote_prefix>/<relative path>, one install-tree
    command per chunk. Hidden files (any dot-prefixed component) and the relative paths in `skip` are left out.
    Every path and file is checked before the first byte is sent. Returns the remote-relative paths pushed."""
    root = Path(local_dir)
    plan = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if any(part.startswith(".") for part in rel.split("/")) or rel in skip or path.is_dir():
            continue
        remote = "%s/%s" % (remote_prefix, rel)
        if path.is_symlink() or not path.is_file():
            raise ValidationError("Not a regular file: " + rel)
        if len(remote) > dispatcher.MAX_TREE_PATH or not dispatcher.GRAMMAR["install-tree"].fullmatch(
                "install-tree %s put" % remote):
            raise ValidationError("Cannot push %s: name not allowed on the TV" % rel)
        data = path.read_bytes()
        if not data:
            raise ValidationError("Cannot push an empty file: " + rel)
        plan.append((remote, data))
    for remote, data in plan:
        chunks = [data[i:i + CHUNK] for i in range(0, len(data), CHUNK)]
        for index, chunk in enumerate(chunks):
            mode = "put" if len(chunks) == 1 else "begin" if index == 0 else "end" if index == len(chunks) - 1 else "more"
            transport.run(dispatcher.build_install_tree(remote, mode), data=chunk, timeout=60)
    return [remote for remote, _ in plan]


def _tv_server_sources():
    source = tv_server_dir()
    hook = source / TV_SERVER_HOOK_SOURCE
    if not hook.is_file():
        raise FileNotFoundError("TV server hook not found at %s" % hook)
    return source, hook, web_dir()


def _install_tv_server(transport):
    source, hook, web = _tv_server_sources()
    files = push_tree(transport, source, TV_SERVER_DIR, skip=TV_SERVER_KEEP_REMOTE + (TV_SERVER_HOOK_SOURCE,))
    files += push_tree(transport, web, TV_SERVER_DIR + "/web")
    transport.run(dispatcher.build_install_hook(TV_SERVER_HOOK), data=_checked(hook.read_bytes()), timeout=60)
    output = transport.run(dispatcher.build_run_hook(TV_SERVER_HOOK, "start"), timeout=60)
    return {"files": files, "hook": TV_SERVER_HOOK, "started": True, "output": output.decode(errors="replace").strip()}


def install(transport, *, overlay=True, vtcap="auto", tv_server=False) -> dict:
    """Push every TV file; optionally the overlay app, the native capture client and the on-TV server.
    vtcap: "auto" installs it only if tv-assets/vtcap/vtcap has been built locally, "yes" requires it."""
    if vtcap not in VTCAP_MODES:
        raise ValidationError("vtcap must be one of " + ", ".join(VTCAP_MODES))
    binary = assets_dir() / "vtcap" / "vtcap"
    if vtcap == "yes" and not binary.is_file():
        raise FileNotFoundError("Build the capture client first: tv-assets/vtcap/build.sh")
    if tv_server:  # fail on missing local files before anything is pushed
        _tv_server_sources()
    result = {"files": _push_files(transport), "overlay": False, "vtcap": False}
    if overlay:
        transport.run(dispatcher.build_install_overlay(), data=_checked(package_overlay()), timeout=120)
        result["overlay"] = True
    if vtcap != "no" and binary.is_file():
        transport.run(dispatcher.build_install_vtcap(), data=_checked(binary.read_bytes()), timeout=120)
        result["vtcap"] = True
    if tv_server:
        result["tv_server"] = _install_tv_server(transport)
    return result


def update(transport) -> dict:
    """Re-push INSTALL_FILES only (the overlay app and vtcap are not touched)."""
    return {"files": _push_files(transport)}


def uninstall(transport) -> dict:
    transport.run(dispatcher.build_uninstall_all(), timeout=60)
    return {"removed": True, "note": AUTHORIZED_KEYS_HINT}


def status(transport) -> dict:
    """What the TV reports as installed: {"files": {name: bool}, "overlay": bool, "vtcap": bool}."""
    out = transport.run(dispatcher.build_install_status(), timeout=20)
    try:
        doc = json.loads(out)
    except ValueError:
        doc = None
    if (not isinstance(doc, dict) or not isinstance(doc.get("files"), dict)
            or type(doc.get("overlay")) is not bool or type(doc.get("vtcap")) is not bool
            or not all(type(doc["files"].get(name)) is bool for name in INSTALL_FILES)):
        raise RuntimeError("TV returned a malformed install status")
    return {"files": {name: doc["files"][name] for name in INSTALL_FILES},
            "overlay": doc["overlay"], "vtcap": doc["vtcap"]}
