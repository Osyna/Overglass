import json

import pytest

from tests.fakes import FakeTransport
from webos_foundry import addons, connectors, notify
from webos_foundry.errors import ValidationError


def test_catalog_lists_every_registered_connector_without_touching_disk(tmp_path):
    entries = addons.catalog()
    assert entries == [dict(connectors.META["football"], id="football")]
    assert not list(tmp_path.iterdir())  # catalog never creates config


def test_install_defaults_and_round_trip(tmp_path):
    entry = addons.install("football", {"params": {"league": "bl2"}}, tmp_path)
    assert entry == {"params": {"league": "bl2"}, "interval_seconds": 90, "enabled": True}
    assert addons.load(tmp_path) == {"football": entry}


def test_install_accepts_interval_position_size(tmp_path):
    entry = addons.install("football", {"params": {}, "interval_seconds": 30, "enabled": False,
                                         "position": "bottom-left", "size": "xl"}, tmp_path)
    assert entry == {"params": {}, "interval_seconds": 30, "enabled": False,
                      "position": "bottom-left", "size": "xl"}


def test_installing_an_enabled_addon_disables_every_other_one(tmp_path):
    addons.install("football", {"params": {}, "enabled": True}, tmp_path)
    # a clone registered just for this test would need a second connector; simulate by writing storage directly
    addons._write({"football": {"params": {}, "interval_seconds": 60, "enabled": True},
                    "weather": {"params": {}, "interval_seconds": 60, "enabled": True}}, tmp_path)
    addons.install("football", {"params": {}, "enabled": True}, tmp_path)
    saved = addons.load(tmp_path)
    assert saved["football"]["enabled"] is True
    assert saved["weather"]["enabled"] is False


def test_installing_disabled_does_not_touch_other_entries(tmp_path):
    addons.install("football", {"params": {}, "enabled": True}, tmp_path)
    addons._write({"football": {"params": {}, "interval_seconds": 60, "enabled": True},
                    "weather": {"params": {}, "interval_seconds": 60, "enabled": True}}, tmp_path)
    addons.install("football", {"params": {}, "enabled": False}, tmp_path)
    assert addons.load(tmp_path)["weather"]["enabled"] is True


@pytest.mark.parametrize("body", [
    None, [], "params", {"params": "not an object"}, {"params": {}, "interval_seconds": 5},
    {"params": {}, "interval_seconds": 9999}, {"params": {}, "interval_seconds": "60"},
    {"params": {}, "enabled": "yes"}, {"params": {}, "position": "nowhere"}, {"params": {}, "size": "huge"},
])
def test_install_rejects_invalid_entries(tmp_path, body):
    with pytest.raises(ValidationError):
        addons.install("football", body, tmp_path)
    assert addons.load(tmp_path) == {}


def test_install_rejects_unknown_addon(tmp_path):
    with pytest.raises(ValidationError, match="Unknown addon: missing"):
        addons.install("missing", {"params": {}}, tmp_path)


def test_uninstall_removes_the_entry(tmp_path):
    addons.install("football", {"params": {}}, tmp_path)
    addons.uninstall("football", tmp_path)
    assert addons.load(tmp_path) == {}


def test_uninstall_unknown_addon_is_a_validation_error(tmp_path):
    with pytest.raises(ValidationError, match="No such installed addon"):
        addons.uninstall("football", tmp_path)


def test_load_rejects_malformed_storage(tmp_path):
    (tmp_path / addons.FILE).write_text("not json")
    with pytest.raises(ValidationError):
        addons.load(tmp_path)


def test_preview_polls_and_shows_without_installing(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(connectors, "CONNECTORS",
                         {"football": lambda params: calls.append(params) or
                          notify.check_overlay_request({"title": "Preview", "kind": "info"})})
    transport = FakeTransport({"notify-overlay": '{"returnValue": true, "overlay": "shown"}'})
    message = addons.preview("football", {"league": "bl2"}, transport)
    assert message == "Overlay card shown"
    assert calls == [{"league": "bl2"}]
    assert addons.load(tmp_path) == {}  # preview never touches install state


def test_preview_rejects_unknown_addon():
    with pytest.raises(ValidationError, match="Unknown addon: missing"):
        addons.preview("missing", {}, FakeTransport())


def test_card_for_applies_saved_position_and_size(monkeypatch):
    monkeypatch.setattr(connectors, "CONNECTORS",
                         {"football": lambda params: notify.check_overlay_request({"title": "t", "kind": "info"})})
    card = addons.card_for("football", {"params": {}, "interval_seconds": 60, "enabled": True,
                                         "position": "bottom-left", "size": "xl"})
    assert card["position"] == "bottom-left" and card["size"] == "xl"


def test_card_for_leaves_the_connectors_own_choices_when_unset(monkeypatch):
    monkeypatch.setattr(connectors, "CONNECTORS",
                         {"football": lambda params: notify.check_overlay_request({"title": "t", "kind": "info",
                                                                                   "size": "l"})})
    card = addons.card_for("football", {"params": {}, "interval_seconds": 60, "enabled": True})
    assert card["size"] == "l" and "position" not in card
