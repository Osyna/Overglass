import json
import re
import stat

import pytest

from webos_foundry import webhooks
from webos_foundry.errors import ValidationError


def test_create_load_resolve_delete_round_trip(tmp_path):
    assert webhooks.load(tmp_path) == {}
    assert webhooks.resolve("unknown", tmp_path) is None
    token = webhooks.create("movie-night", "Movie night", tmp_path)
    assert re.fullmatch(r"[A-Za-z0-9_-]{32}", token)
    entry = {"scene": "movie-night", "label": "Movie night"}
    assert webhooks.load(tmp_path) == {token: entry}
    assert webhooks.resolve(token, tmp_path) == entry
    assert stat.S_IMODE((tmp_path / webhooks.FILE).stat().st_mode) == 0o600
    other = webhooks.create("not-created-yet", config_dir_override=tmp_path)
    assert other != token
    assert webhooks.resolve(other, tmp_path) == {"scene": "not-created-yet", "label": ""}
    webhooks.delete(token, tmp_path)
    assert webhooks.load(tmp_path) == {other: {"scene": "not-created-yet", "label": ""}}
    assert webhooks.resolve(token, tmp_path) is None
    with pytest.raises(ValidationError, match="No such webhook"):
        webhooks.delete(token, tmp_path)


@pytest.mark.parametrize("scene", [None, 12, "", "x" * 61, " leading", "trailing "])
def test_create_rejects_bad_scene_names(tmp_path, scene):
    with pytest.raises(ValidationError):
        webhooks.create(scene, config_dir_override=tmp_path)
    assert webhooks.load(tmp_path) == {}


@pytest.mark.parametrize("label", [12, False, [], "x" * 61])
def test_create_rejects_bad_labels(tmp_path, label):
    with pytest.raises(ValidationError):
        webhooks.create("scene", label, tmp_path)


def test_create_accepts_maximum_lengths(tmp_path):
    token = webhooks.create("s" * 60, "l" * 60, tmp_path)
    assert webhooks.resolve(token, tmp_path) == {"scene": "s" * 60, "label": "l" * 60}


@pytest.mark.parametrize("contents", ["not json", "[]", json.dumps({"x": {"scene": "s"}}),
                                      json.dumps({"x": {"scene": "", "label": ""}})])
def test_load_rejects_malformed_file(tmp_path, contents):
    (tmp_path / webhooks.FILE).write_text(contents)
    with pytest.raises(ValidationError):
        webhooks.load(tmp_path)


@pytest.mark.parametrize("token", [None, [], {}, "unknown"])
def test_resolve_unknown_or_invalid_token_returns_none(tmp_path, token):
    assert webhooks.resolve(token, tmp_path) is None


def test_failed_replace_keeps_saved_webhooks_and_removes_temp_file(tmp_path, monkeypatch):
    token = webhooks.create("scene", config_dir_override=tmp_path)

    def fail_replace(*args):
        raise OSError("disk error")

    monkeypatch.setattr(webhooks.os, "replace", fail_replace)
    with pytest.raises(OSError, match="disk error"):
        webhooks.delete(token, tmp_path)
    assert webhooks.resolve(token, tmp_path) == {"scene": "scene", "label": ""}
    assert [path.name for path in tmp_path.iterdir()] == [webhooks.FILE]
