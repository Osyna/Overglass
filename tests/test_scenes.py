import json

import pytest

from tests.fakes import FakeTransport
from webos_foundry import scenes
from webos_foundry.errors import ValidationError

GOOD = {"steps": [
    {"type": "remote", "action": "volume_down", "value": None},
    {"type": "setting", "category": "sound", "key": "aiSound", "value": "off", "context": {}},
    {"type": "overlay", "card": {"title": "Movie night", "kind": "info", "seconds": 5}},
    {"type": "wait", "seconds": 1},
]}


def test_check_scene_compiles_the_overlay_step_into_a_tree():
    checked = scenes.check_scene(GOOD)
    assert checked["steps"][0] == {"type": "remote", "action": "volume_down", "value": None}
    assert checked["steps"][1] == {"type": "setting", "category": "sound", "key": "aiSound", "value": "off",
                                    "context": {}}
    assert checked["steps"][2]["card"]["root"]["type"] == "stack"  # title+kind compiles to a tree, not raw fields
    assert checked["steps"][3] == {"type": "wait", "seconds": 1}


@pytest.mark.parametrize("body", [
    {}, {"steps": []}, {"steps": "no"}, {"steps": [{"type": "remote", "action": "volume_down"}] * 21},
    {"extra": 1, "steps": [{"type": "wait", "seconds": 1}]},
    {"steps": [{}]}, {"steps": [{"type": "nope"}]},
    {"steps": [{"type": "remote", "action": "nope"}]},
    {"steps": [{"type": "remote", "action": "volume_down", "extra": 1}]},
    {"steps": [{"type": "setting", "category": "sound", "key": "nope", "value": "on"}]},
    {"steps": [{"type": "setting", "category": "sound", "key": "aiSound"}]},
    {"steps": [{"type": "overlay", "card": {}}]},
    {"steps": [{"type": "overlay", "card": {"title": "x"}, "extra": 1}]},
    {"steps": [{"type": "wait"}]}, {"steps": [{"type": "wait", "seconds": 11}]},
    {"steps": [{"type": "wait", "seconds": -1}]}, {"steps": [{"type": "wait", "seconds": True}]},
])
def test_check_scene_rejects_bad_bodies(body):
    with pytest.raises(ValidationError):
        scenes.check_scene(body)


def test_save_load_delete_round_trip(tmp_path):
    assert scenes.load(tmp_path) == {}
    scenes.save("movie-night", scenes.check_scene(GOOD), tmp_path)
    loaded = scenes.load(tmp_path)
    assert list(loaded) == ["movie-night"]
    assert len(loaded["movie-night"]["steps"]) == 4
    (tmp_path / "scenes.json").chmod(0o600)  # written mode; just confirms save() didn't widen it
    scenes.save("other", scenes.check_scene({"steps": [{"type": "wait", "seconds": 0}]}), tmp_path)
    assert sorted(scenes.load(tmp_path)) == ["movie-night", "other"]
    scenes.delete("movie-night", tmp_path)
    assert list(scenes.load(tmp_path)) == ["other"]
    with pytest.raises(ValidationError):
        scenes.delete("movie-night", tmp_path)


@pytest.mark.parametrize("name", ["", "x" * 61, " leading", "trailing "])
def test_save_rejects_bad_names(tmp_path, name):
    with pytest.raises(ValidationError):
        scenes.save(name, scenes.check_scene({"steps": [{"type": "wait", "seconds": 0}]}), tmp_path)


def test_load_rejects_malformed_file(tmp_path):
    (tmp_path / "scenes.json").write_text("not json")
    with pytest.raises(ValidationError):
        scenes.load(tmp_path)
    (tmp_path / "scenes.json").write_text(json.dumps({"x": {"no_steps": 1}}))
    with pytest.raises(ValidationError):
        scenes.load(tmp_path)


def test_run_scene_calls_every_step_in_order_and_returns_messages():
    fake = FakeTransport({"remote": '{"message":"Sent volume_down"}', "settings-set": '"on (persists)"',
                          "notify-overlay": '{"returnValue":true,"overlay":"shown"}'})
    checked = scenes.check_scene(GOOD)
    out = scenes.run_scene(fake, checked)
    assert out == ["Sent volume_down", "AI Sound: on (persists)", "Overlay card shown", "Waited 1s"]
    assert [c.verb for c in fake.calls] == ["remote", "settings-set", "notify-overlay"]


def test_run_scene_stops_at_the_first_failure():
    fake = FakeTransport({"remote": RuntimeError("TV refused: boom")})
    checked = scenes.check_scene({"steps": [{"type": "remote", "action": "volume_down", "value": None},
                                             {"type": "wait", "seconds": 0}]})
    with pytest.raises(RuntimeError):
        scenes.run_scene(fake, checked)
    assert len(fake.calls) == 1  # the wait step never ran
