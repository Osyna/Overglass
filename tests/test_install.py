from pathlib import Path
import base64
import io
import json
import tarfile

import pytest

from tests.fakes import FakeTransport, make_assets
from webos_foundry import dispatcher, install
from webos_foundry.errors import TransportError, ValidationError


@pytest.fixture
def assets(monkeypatch, tmp_path):
    root = make_assets(tmp_path / "tv-assets")
    monkeypatch.setenv("WEBOS_FOUNDRY_ASSETS", str(root))
    return root


def tv():
    return FakeTransport({"install": b"", "install-overlay": b"", "install-vtcap": b"", "uninstall-all": b""})


def test_install_files_come_from_dispatcher():
    assert install.INSTALL_FILES is dispatcher.INSTALL_FILES


def decoded(call):
    return base64.b64decode(call.command.split(" ")[-1])


def test_install_pushes_files_dispatcher_last_then_overlay(assets):
    fake = tv()
    result = install.install(fake)
    names = [c.split()[1] for c in fake.commands if c.startswith("install ")]
    assert names == ["status.sh", "details.js", "notify.js", "settings.js", "remote.js", "process-image.js",
                     "process-audio.js", "dispatch.sh"]
    assert decoded(fake.calls[0]) == (assets / "status.sh").read_bytes()
    assert fake.commands[-1].startswith("install-overlay ")
    assert result == {"files": names, "overlay": True, "vtcap": False}
    assert all(dispatcher.verb_of(c) for c in fake.commands)


def test_install_options(assets):
    fake = tv()
    result = install.install(fake, overlay=False)
    assert result["overlay"] is False and result["vtcap"] is False and len(result["files"]) == 8
    assert not any(c.startswith(("install-overlay", "install-vtcap")) for c in fake.commands)
    make_assets(assets, vtcap=True)
    fake = tv()
    assert install.install(fake, overlay=False)["vtcap"] is True  # auto: binary built locally
    assert decoded(fake.calls[-1]) == b"\x7fELF" and fake.commands[-1].startswith("install-vtcap ")
    fake = tv()
    assert install.install(fake, overlay=False, vtcap="no")["vtcap"] is False
    assert not any(c.startswith("install-vtcap") for c in fake.commands)


def test_install_vtcap_yes_needs_a_built_binary(assets):
    fake = tv()
    with pytest.raises(FileNotFoundError, match="build.sh"):
        install.install(fake, vtcap="yes")
    assert fake.calls == []
    with pytest.raises(ValidationError):
        install.install(fake, vtcap="maybe")


def test_update_only_pushes_files(assets):
    fake = tv()
    assert len(install.update(fake)["files"]) == 8 and len(fake.calls) == 8
    assert all(c.startswith("install ") for c in fake.commands)


def test_uninstall_sends_one_verb_and_explains_authorized_keys(assets):
    fake = tv()
    result = install.uninstall(fake)
    assert fake.commands == ["uninstall-all"] and result["removed"] is True and "authorized_keys" in result["note"]


def test_transport_errors_propagate(assets):
    with pytest.raises(TransportError):
        install.install(FakeTransport({"install": TransportError("read-only filesystem")}))


def test_oversize_payload_refused_before_sending(assets):
    (assets / "details.js").write_bytes(b"x" * 100_000)
    fake = tv()
    with pytest.raises(ValidationError, match="too large"):
        install.update(fake)
    assert [c.split()[1] for c in fake.commands] == ["status.sh"]


def test_missing_assets(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBOS_FOUNDRY_ASSETS", str(tmp_path / "nope"))
    with pytest.raises(FileNotFoundError, match="WEBOS_FOUNDRY_ASSETS"):
        install.update(tv())


def test_default_assets_dir_is_repo_root(monkeypatch):
    monkeypatch.delenv("WEBOS_FOUNDRY_ASSETS", raising=False)
    assert install.assets_dir().name == "tv-assets"


def test_status_parsing():
    reply = {"files": {name: True for name in dispatcher.INSTALL_FILES}, "overlay": True, "vtcap": False}
    assert install.status(FakeTransport({"install-status": json.dumps(reply)})) == reply
    missing = {**reply, "files": {**reply["files"], "notify.js": False}}
    assert install.status(FakeTransport({"install-status": json.dumps(missing)}))["files"]["notify.js"] is False
    for bad in ("nope", "[]", json.dumps({**reply, "overlay": "yes"}), json.dumps({**reply, "files": {}}),
                json.dumps({"files": reply["files"], "overlay": True})):
        with pytest.raises(RuntimeError, match="malformed"):
            install.status(FakeTransport({"install-status": bad}))


def members(ipk):
    assert ipk.startswith(b"!<arch>\n")
    found, offset = {}, 8
    while offset < len(ipk):
        name, size = ipk[offset:offset + 16].decode().strip(), int(ipk[offset + 48:offset + 58])
        assert ipk[offset + 58:offset + 60] == b"`\n"
        found[name] = ipk[offset + 60:offset + 60 + size]
        offset += 60 + size + size % 2
    return found


def test_overlay_ipk_layout(assets):
    found = members(install.package_overlay())
    assert list(found) == ["debian-binary", "control.tar.gz", "data.tar.gz"] and found["debian-binary"] == b"2.0\n"
    with tarfile.open(fileobj=io.BytesIO(found["data.tar.gz"])) as tar:
        names = tar.getnames()
        info = json.loads(tar.extractfile("./usr/palm/packages/dev.webosfoundry.overlay/packageinfo.json").read())
    app = "./usr/palm/applications/dev.webosfoundry.overlay/"
    for needed in ("appinfo.json", "index.html", "overlay.js", "overlay.css", "icon.png"):
        assert app + needed in names
    assert info["id"] == "dev.webosfoundry.overlay" and info["package_format_version"] == 2
    with tarfile.open(fileobj=io.BytesIO(found["control.tar.gz"])) as tar:
        control = tar.extractfile("./control").read().decode()
    assert control.startswith("Package: dev.webosfoundry.overlay\nVersion: 1.0.0\n") and "Maintainer: v\n" in control


def test_real_overlay_assets_package_if_present():
    real = Path(__file__).resolve().parent.parent / "tv-assets" / "overlay"
    if not (real / "appinfo.json").is_file():
        pytest.skip("tv-assets/overlay not present yet")
    with tarfile.open(fileobj=io.BytesIO(members(install.package_overlay(real))["data.tar.gz"])) as tar:
        assert "./usr/palm/applications/dev.webosfoundry.overlay/appinfo.json" in tar.getnames()
