import json
import os
import stat

import pytest

from webos_foundry.config import Config, config_dir
from webos_foundry.errors import ConfigError, NotPairedError


def test_env_override_and_default(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path / "home"))
    assert config_dir() == tmp_path / "home"
    assert config_dir(tmp_path / "cli") == tmp_path / "cli"  # explicit override wins
    monkeypatch.delenv("WEBOS_FOUNDRY_HOME")
    assert config_dir().name == "webos-foundry" and config_dir().parent.name == ".config"


def test_save_load_roundtrip_mode_and_atomic(tmp_path):
    config = Config.for_dir(tmp_path, tv_host="192.168.1.50", mac="AA:BB:CC:DD:EE:FF", server_token="t")
    path = config.save(tmp_path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert Config.load(tmp_path) == config
    assert json.loads(path.read_text())["key_path"] == str(tmp_path / "id_ed25519")
    assert [p.name for p in tmp_path.iterdir()] == ["config.json"]  # no temp file left behind


def test_load_uses_env(monkeypatch, tmp_path):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path))
    Config.for_dir(tmp_path, tv_host="h").save()
    assert Config.load().tv_host == "h"


def test_save_failure_keeps_old_file_and_cleans_temp(tmp_path, monkeypatch):
    Config.for_dir(tmp_path, tv_host="old").save(tmp_path)
    monkeypatch.setattr(os, "replace", lambda *a: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(OSError):
        Config.for_dir(tmp_path, tv_host="new").save(tmp_path)
    monkeypatch.undo()
    assert Config.load(tmp_path).tv_host == "old"
    assert [p.name for p in tmp_path.iterdir()] == ["config.json"]


@pytest.mark.parametrize("content", ["not json", "[]", '{"nope": 1}', '{"tv_host": 5}', '{"ssh_port": "22"}',
                                     '{"ssh_port": true}', '{"mac": 3}'])
def test_malformed_config_raises(tmp_path, content):
    (tmp_path / "config.json").write_text(content)
    with pytest.raises(ConfigError):
        Config.load(tmp_path)


def test_missing_config_is_config_error_and_require_is_not_paired(tmp_path):
    with pytest.raises(ConfigError):
        Config.load(tmp_path)
    with pytest.raises(NotPairedError, match="wof pair"):
        Config.require(tmp_path)


def test_require_needs_host(tmp_path):
    Config.for_dir(tmp_path).save(tmp_path)
    with pytest.raises(NotPairedError):
        Config.require(tmp_path)
    Config.for_dir(tmp_path, tv_host="192.168.1.50").save(tmp_path)
    assert Config.require(tmp_path).tv_host == "192.168.1.50"


def test_require_malformed_stays_config_error(tmp_path):
    (tmp_path / "config.json").write_text("{")
    with pytest.raises(ConfigError):
        Config.require(tmp_path)
