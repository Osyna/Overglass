"""Push, refresh and remove the TV-side assets over the dedicated (restricted) key.

`tv-assets/` lives at the repository root, not inside the package, so a plain checkout or editable
install works and a wheel does not carry it yet. Set WEBOS_FOUNDRY_ASSETS to point at another copy;
moving the directory into package data is a packaging follow-up.
"""
import base64
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
VTCAP_MODES = ("auto", "yes", "no")
# The base64 payload is one SSH command argument; Linux caps a single argument at 128 KiB.
MAX_PAYLOAD_B64 = 120_000
AUTHORIZED_KEYS_HINT = ("The restricted key line in /home/root/.ssh/authorized_keys (the one starting with "
                        "command=\"sh /var/lib/webosbrew/webos-foundry/dispatch.sh\") is left in place; "
                        "delete it by hand to finish removing webOS Foundry.")


def assets_dir() -> Path:
    path = Path(os.environ.get(ASSETS_ENV) or Path(__file__).resolve().parent.parent / "tv-assets")
    if not path.is_dir():
        raise FileNotFoundError("TV assets not found at %s (set %s)" % (path, ASSETS_ENV))
    return path


def _payload(data):
    encoded = base64.b64encode(data).decode()
    if len(encoded) > MAX_PAYLOAD_B64:
        raise ValidationError("File is too large to send in one SSH command")
    return encoded


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
        transport.run(dispatcher.build_install(name, _payload((root / name).read_bytes())), timeout=60)
    return list(names)


def install(transport, *, overlay=True, vtcap="auto") -> dict:
    """Push every TV file; optionally the overlay app and the native capture client.
    vtcap: "auto" installs it only if tv-assets/vtcap/vtcap has been built locally, "yes" requires it."""
    if vtcap not in VTCAP_MODES:
        raise ValidationError("vtcap must be one of " + ", ".join(VTCAP_MODES))
    binary = assets_dir() / "vtcap" / "vtcap"
    if vtcap == "yes" and not binary.is_file():
        raise FileNotFoundError("Build the capture client first: tv-assets/vtcap/build.sh")
    result = {"files": _push_files(transport), "overlay": False, "vtcap": False}
    if overlay:
        transport.run(dispatcher.build_install_overlay(_payload(package_overlay())), timeout=120)
        result["overlay"] = True
    if vtcap != "no" and binary.is_file():
        transport.run(dispatcher.build_install_vtcap(_payload(binary.read_bytes())), timeout=120)
        result["vtcap"] = True
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
