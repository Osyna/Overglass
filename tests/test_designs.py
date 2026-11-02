import json

import pytest

from tests.fakes import FakeTransport
from webos_foundry import designs, scenes
from webos_foundry.errors import ValidationError

CARD = {"theme": {"accent": "#C8F542", "radius": 0}, "seconds": 0, "regions": [
    {"position": "top", "size": "full", "root": {"type": "row", "children": [
        {"type": "text", "text": "0 - 0", "size": "xl", "weight": "strong", "color": "accent"}]}},
    {"position": "right", "root": {"type": "stack", "children": [
        {"type": "section", "title": "Live events", "icon": "bolt"},
        {"type": "event", "time": "12'", "text": "Goal", "tone": "accent"}]}},
]}


def test_save_validates_and_round_trips(tmp_path):
    saved = designs.save("match-day", CARD, tmp_path)
    assert saved["theme"] == {"accent": "#c8f542", "radius": 0}  # normalised by the overlay validator
    assert designs.load(tmp_path) == {"match-day": saved}


def test_save_rejects_invalid_cards_and_names(tmp_path):
    with pytest.raises(ValidationError):
        designs.save("x", {"root": {"type": "nope"}}, tmp_path)
    with pytest.raises(ValidationError, match="not a hide request"):
        designs.save("x", {"hide": True}, tmp_path)
    with pytest.raises(ValidationError, match="design name"):
        designs.save(" spaced ", CARD, tmp_path)
    assert designs.load(tmp_path) == {}


def test_delete_and_missing(tmp_path):
    designs.save("a", CARD, tmp_path)
    designs.delete("a", tmp_path)
    assert designs.load(tmp_path) == {}
    with pytest.raises(ValidationError, match="No such design"):
        designs.delete("a", tmp_path)


def test_load_rejects_malformed_storage(tmp_path):
    (tmp_path / designs.FILE).write_text('{"a": {"nothing": 1}}')
    with pytest.raises(ValidationError, match="malformed"):
        designs.load(tmp_path)


def test_show_sends_the_saved_card(tmp_path):
    designs.save("match-day", CARD, tmp_path)
    transport = FakeTransport({"notify-overlay": '{"returnValue": true, "overlay": "shown"}'})
    assert designs.show(transport, "match-day", tmp_path) == "Overlay card shown"
    sent = json.loads(transport.calls[0].data)
    assert [r["position"] for r in sent["regions"]] == ["top", "right"]
    with pytest.raises(ValidationError, match="No such design"):
        designs.show(transport, "other", tmp_path)


def test_scene_overlay_step_can_reference_a_design(tmp_path, monkeypatch):
    monkeypatch.setenv("WEBOS_FOUNDRY_HOME", str(tmp_path))
    step = scenes.check_scene({"steps": [{"type": "overlay", "design": "match-day"}]})["steps"][0]
    assert step == {"type": "overlay", "design": "match-day"}
    with pytest.raises(ValidationError, match="either card or design"):
        scenes.check_scene({"steps": [{"type": "overlay", "design": "x", "card": {"title": "t"}}]})
    transport = FakeTransport({"notify-overlay": '{"returnValue": true, "overlay": "shown"}'})
    with pytest.raises(ValidationError, match="No such design"):  # resolved at run time, not at save time
        scenes.run_step(transport, step)
    designs.save("match-day", CARD)
    assert scenes.run_step(transport, step) == "Overlay card shown"
