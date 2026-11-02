from pathlib import Path
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
    return call.data


def test_install_pushes_files_dispatcher_last_then_overlay(assets):
    fake = tv()
    result = install.install(fake)
    names = [c.split()[1] for c in fake.commands if c.startswith("install ")]
    assert names == ["status.sh", "details.js", "notify.js", "settings.js", "remote.js", "process-image.js",
                     "process-audio.js", "apps.js", "dispatch.sh"]
    assert decoded(fake.calls[0]) == (assets / "status.sh").read_bytes()
    assert fake.commands[-1] == "install-overlay"
    assert result == {"files": names, "overlay": True, "vtcap": False}
    assert all(dispatcher.verb_of(c) for c in fake.commands)


def test_install_options(assets):
    fake = tv()
    result = install.install(fake, overlay=False)
    assert result["overlay"] is False and result["vtcap"] is False and len(result["files"]) == 9
    assert not any(c.startswith(("install-overlay", "install-vtcap")) for c in fake.commands)
    make_assets(assets, vtcap=True)
    fake = tv()
    assert install.install(fake, overlay=False)["vtcap"] is True  # auto: binary built locally
    assert decoded(fake.calls[-1]) == b"\x7fELF" and fake.commands[-1] == "install-vtcap"
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
    assert len(install.update(fake)["files"]) == 9 and len(fake.calls) == 9
    assert all(c.startswith("install ") for c in fake.commands)


def test_uninstall_sends_one_verb_and_explains_authorized_keys(assets):
    fake = tv()
    result = install.uninstall(fake)
    assert fake.commands == ["uninstall-all"] and result["removed"] is True and "authorized_keys" in result["note"]


def test_transport_errors_propagate(assets):
    with pytest.raises(TransportError):
        install.install(FakeTransport({"install": TransportError("read-only filesystem")}))


def test_oversize_payload_refused_before_sending(assets):
    (assets / "details.js").write_bytes(b"x" * (install.FILE_MAX + 1))
    fake = tv()
    with pytest.raises(ValidationError, match="File must be"):
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


# ---- generic directory push and the on-TV server

def tree(root, files):
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return root


def tree_fake():
    return FakeTransport({"install-tree": b"", "install-hook": b"", "run-hook": b"started\n", "install": b"",
                          "install-overlay": b"", "install-vtcap": b""})


def tree_paths(fake):
    return [c.split()[1] for c in fake.commands if c.startswith("install-tree ")]


def test_push_tree_walks_nested_directories(tmp_path):
    local = tree(tmp_path / "web", {"index.html": b"<html>", "css/app.css": b"a{}", "js/lib/x.js": b"x", "fonts/a.woff2": b"\0w"})
    fake = tree_fake()
    pushed = install.push_tree(fake, local, "tv-server/web")
    assert pushed == ["tv-server/web/css/app.css", "tv-server/web/fonts/a.woff2", "tv-server/web/index.html",
                      "tv-server/web/js/lib/x.js"]
    assert tree_paths(fake) == pushed and all(dispatcher.verb_of(c) == "install-tree" for c in fake.commands)
    assert all(c.split()[2] == "put" for c in fake.commands)
    assert [decoded(call) for call in fake.calls] == [b"a{}", b"\0w", b"<html>", b"x"]


def test_push_tree_skips_hidden_files_and_named_paths(tmp_path):
    local = tree(tmp_path / "t", {"server.js": b"s", "config.json": b"{}", ".DS_Store": b"x", ".git/HEAD": b"x", "a/.hid": b"x"})
    fake = tree_fake()
    assert install.push_tree(fake, local, "tv-server", skip=("config.json",)) == ["tv-server/server.js"]


def test_push_tree_chunks_large_files_without_padding_until_the_last(tmp_path):
    size = install.CHUNK * 2 + 777  # three chunks: two full, one partial
    data = (bytes(range(256)) * (size // 256 + 1))[:size]
    local = tree(tmp_path / "t", {"big.bin": data, "small.txt": b"hi"})
    fake = tree_fake()
    install.push_tree(fake, local, "d")
    big = [c for c in fake.calls if c.command.split()[1] == "d/big.bin"]
    assert [c.command.split()[2] for c in big] == ["begin", "more", "end"]
    assert all(len(c.data) <= install.CHUNK for c in big)
    assert b"".join(decoded(c) for c in big) == data
    assert [c.command.split()[2] for c in fake.calls if "small.txt" in c.command] == ["put"]


def test_push_tree_exact_chunk_boundary_has_no_empty_chunk(tmp_path):
    local = tree(tmp_path / "t", {"x.bin": b"z" * install.CHUNK})
    fake = tree_fake()
    install.push_tree(fake, local, "d")
    assert [c.command.split()[2] for c in fake.calls] == ["put"]


@pytest.mark.parametrize("name", ["has space.js", "semi;colon.js", "dollar$.js", "é.js", "a'b.js", "x" * 65, "a/" + "b" * 65,
                                  "-".join(["d"] * 4) + "/" + "/".join(["d"] * 8)])
def test_push_tree_refuses_names_the_tv_would_refuse_before_sending_anything(tmp_path, name):
    local = tree(tmp_path / "t", {"ok.js": b"fine", name: b"bad"})
    fake = tree_fake()
    with pytest.raises(ValidationError):
        install.push_tree(fake, local, "tv-server")
    assert fake.calls == []


def test_push_tree_refuses_symlinks_and_empty_files(tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    local = tree(tmp_path / "t", {"ok.js": b"fine"})
    (local / "link.txt").symlink_to(outside)
    fake = tree_fake()
    with pytest.raises(ValidationError, match="regular file"):
        install.push_tree(fake, local, "d")
    (local / "link.txt").unlink()
    (local / "empty.txt").write_bytes(b"")
    with pytest.raises(ValidationError, match="empty"):
        install.push_tree(fake, local, "d")
    assert fake.calls == []


def test_push_tree_never_emits_an_escaping_path(tmp_path):
    local = tree(tmp_path / "t", {"a/b/c.js": b"1", "a/d.js": b"2", "e/f/g/h.js": b"3"})
    fake = tree_fake()
    install.push_tree(fake, local, "tv-server")
    for path in tree_paths(fake):
        assert path.startswith("tv-server/") and not path.startswith("/") and ".." not in path.split("/")
        assert "//" not in path and all(part and not part.startswith(".") for part in path.split("/"))
    for bad_prefix in ("../x", "/etc", "a//b", "a/../b", ".hidden"):  # a caller's bad prefix is refused as well
        with pytest.raises(ValidationError):
            install.push_tree(fake, local, bad_prefix)


@pytest.fixture
def tv_server(monkeypatch, tmp_path, assets):
    server = tree(tmp_path / "tv-server", {"server.js": b"// server", "init.d-hook.sh": b"#!/bin/sh\n", "config.json": b"{}"})
    web = tree(tmp_path / "web", {"index.html": b"<html>", "app.js": b"js", "img/logo.svg": b"<svg/>"})
    monkeypatch.setenv("WEBOS_FOUNDRY_TV_SERVER", str(server))
    monkeypatch.setenv("WEBOS_FOUNDRY_WEB", str(web))
    return server, web


def test_install_without_tv_server_sends_no_tree_or_hook(assets, tv_server):
    fake = tv()
    result = install.install(fake, overlay=False)
    assert "tv_server" not in result and not any(c.startswith(("install-tree", "install-hook", "run-hook")) for c in fake.commands)


def test_install_tv_server_pushes_tree_web_hook_and_starts(assets, tv_server):
    fake = tree_fake()
    result = install.install(fake, overlay=False, vtcap="no", tv_server=True)
    assert tree_paths(fake) == ["tv-server/server.js", "tv-server/web/app.js", "tv-server/web/img/logo.svg",
                                "tv-server/web/index.html"]  # not config.json (TV-owned), not the hook
    assert result["tv_server"] == {"files": tree_paths(fake), "hook": "webos-foundry-tv-server", "started": True,
                                   "output": "started"}
    assert fake.commands[-2] == "install-hook webos-foundry-tv-server"
    assert decoded(fake.calls[-2]) == b"#!/bin/sh\n"
    assert fake.commands[-1] == "run-hook webos-foundry-tv-server start"
    assert [c.split()[1] for c in fake.commands[:9]] == [n for n in dispatcher.INSTALL_FILES if n != "dispatch.sh"] + ["dispatch.sh"]
    assert all(dispatcher.verb_of(c) for c in fake.commands)


def test_install_tv_server_needs_its_local_files_before_sending_anything(monkeypatch, assets, tv_server, tmp_path):
    server, web = tv_server
    (server / "init.d-hook.sh").unlink()
    fake = tree_fake()
    with pytest.raises(FileNotFoundError, match="hook"):
        install.install(fake, tv_server=True)
    (server / "init.d-hook.sh").write_bytes(b"#!/bin/sh\n")
    monkeypatch.setenv("WEBOS_FOUNDRY_WEB", str(tmp_path / "nope"))
    with pytest.raises(FileNotFoundError, match="WEBOS_FOUNDRY_WEB"):
        install.install(fake, tv_server=True)
    monkeypatch.setenv("WEBOS_FOUNDRY_TV_SERVER", str(tmp_path / "nope"))
    with pytest.raises(FileNotFoundError, match="WEBOS_FOUNDRY_TV_SERVER"):
        install.install(fake, tv_server=True)
    assert fake.calls == []


def test_tv_server_transport_errors_propagate(assets, tv_server):
    fake = tree_fake().add("run-hook", TransportError("No such hook"))
    with pytest.raises(TransportError):
        install.install(fake, overlay=False, vtcap="no", tv_server=True)


def test_tv_server_dir_defaults_to_repo_root_sibling_of_tv_assets(monkeypatch):
    monkeypatch.delenv("WEBOS_FOUNDRY_TV_SERVER", raising=False)
    monkeypatch.delenv("WEBOS_FOUNDRY_WEB", raising=False)
    monkeypatch.delenv("WEBOS_FOUNDRY_ASSETS", raising=False)
    assert install.tv_server_dir().parent == install.assets_dir().parent == install.web_dir().parent


def test_real_tv_server_and_web_trees_pass_the_tv_grammar(monkeypatch):
    for variable in ("WEBOS_FOUNDRY_TV_SERVER", "WEBOS_FOUNDRY_WEB"):
        monkeypatch.delenv(variable, raising=False)
    root = Path(__file__).resolve().parent.parent
    if not (root / "tv-server" / install.TV_SERVER_HOOK_SOURCE).is_file() or not (root / "web").is_dir():
        pytest.skip("tv-server/ or web/ not present")
    fake = tree_fake()
    result = install.install(fake, overlay=False, vtcap="no", tv_server=True)
    assert "tv-server/server.js" in result["tv_server"]["files"]
    assert "tv-server/web/index.html" in result["tv_server"]["files"]
    assert "tv-server/config.json" not in result["tv_server"]["files"]
    assert all(dispatcher.verb_of(c) for c in fake.commands)
