import json

import pytest

from tests.fakes import FakeTransport
from webos_foundry import notify
from webos_foundry.errors import ValidationError


def test_successful_show_and_hide_notify_observers_but_runtime_does_not(monkeypatch):
    observations = []
    monkeypatch.setattr(notify, "OVERLAY_OBSERVERS", [lambda transport, card: observations.append((transport, card))])
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    card = {"root": {"type": "text", "text": "Live"}, "seconds": 0}
    notify.overlay_show(fake, card)
    notify.overlay_runtime(fake, {"dim": 0.4, "compact": True, "hidden": False})
    notify.overlay_hide(fake)
    assert observations == [(fake, card), (fake, {"hide": True})]
    assert json.loads(fake.calls[1].data) == {"action": "runtime", "dim": 0.4, "compact": True, "hidden": False}


def test_failed_tv_send_does_not_publish_successful_show(monkeypatch):
    observations = []
    monkeypatch.setattr(notify, "OVERLAY_OBSERVERS", [lambda transport, card: observations.append(card)])
    fake = FakeTransport({"notify-overlay": "{}"})
    with pytest.raises(RuntimeError):
        notify.overlay_show(fake, {"title": "Unsent"})
    assert observations == []


def test_failed_observer_does_not_change_successful_send(monkeypatch, caplog):
    def broken(transport, card):
        raise RuntimeError("observer failure")
    monkeypatch.setattr(notify, "OVERLAY_OBSERVERS", [broken])
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    assert notify.overlay_show(fake, {"title": "Shown"}) == "Overlay card shown"
    assert "Overlay observer failed" in caplog.text


@pytest.mark.parametrize("values", [None, {"root": {}}, {"dim": 0.1}, {"compact": 1}, {"hidden": "yes"}])
def test_invalid_runtime_state_is_rejected_before_transport(values):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        notify.overlay_runtime(fake, values)
    assert fake.calls == []


@pytest.mark.parametrize("running", [True, False])
def test_overlay_state_reads_actual_liveness_without_observing_or_launching(monkeypatch, running):
    observations = []
    monkeypatch.setattr(notify, "OVERLAY_OBSERVERS", [lambda transport, card: observations.append(card)])
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "running": running})})
    assert notify.overlay_state(fake) == {"running": running}
    assert json.loads(fake.calls[0].data) == {"action": "state"}
    assert observations == []
    assert notify.check_overlay_request({"action": "state"}) == {"action": "state"}
    with pytest.raises(ValidationError):
        notify.inspect_overlay({"action": "state"})


def test_overlay_state_rejects_malformed_service_liveness():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "running": 1})})
    with pytest.raises(RuntimeError, match="liveness"):
        notify.overlay_state(fake)
    with pytest.raises(ValidationError):
        notify.check_overlay_request({"action": "state", "dim": 0.5})
