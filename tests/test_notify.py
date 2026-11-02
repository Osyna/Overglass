import base64
import json

import pytest

from tests.fakes import FakeTransport
from webos_foundry import notify
from webos_foundry.errors import TransportError, ValidationError

OK = json.dumps({"returnValue": True})


def payload(command):
    return base64.b64decode(command.split(" ")[1]).decode()


def test_toast_sends_stripped_text():
    fake = FakeTransport({"notify-toast": OK})
    assert notify.toast(fake, "  héllo ✓ ") == "Toast shown on the TV"
    assert payload(fake.commands[0]) == "héllo ✓"


@pytest.mark.parametrize("text", ["", "   ", "x" * 201, "bad\x00", "line\nbreak", "in\tner", "del\x7f", 5, None, "\ud800",
                                  "é" * 200])
def test_toast_rejects_bad_text_before_transport(text):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        notify.toast(fake, text)
    assert fake.calls == []


def test_toast_boundary_200_ascii_fits():
    fake = FakeTransport({"notify-toast": OK})
    with pytest.raises(ValidationError):  # 200 ASCII chars = 268 base64 chars: fits
        notify.toast(fake, "x" * 201)
    notify.toast(fake, "x" * 200)
    assert len(fake.calls) == 1


def test_say_message_and_volume():
    fake = FakeTransport({"notify-say": json.dumps({"returnValue": True, "spoke": 5, "volume": 20})})
    message = notify.say(fake, "hello", 20)
    assert "Spoke 5 characters at volume 20" in message
    assert fake.commands[0].endswith(" 20") and fake.calls[0].timeout == 60
    notify.say(fake, "hello")
    assert fake.commands[1].endswith(" 15")


@pytest.mark.parametrize("volume", [0, 41, -1, "5", True, 1.5, None])
def test_say_rejects_bad_volume(volume):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        notify.say(fake, "hello", volume)
    assert fake.calls == []


@pytest.mark.parametrize("reply", ["", "not json", "[]", json.dumps({"returnValue": False}), "{}"])
def test_malformed_reply(reply):
    with pytest.raises(RuntimeError, match="malformed"):
        notify.toast(FakeTransport({"notify-toast": reply}), "hi")


def test_reply_uses_last_stdout_line():
    notify.toast(FakeTransport({"notify-toast": "noise\n" + OK + "\n"}), "hi")


def test_transport_error_propagates():
    with pytest.raises(TransportError):
        notify.toast(FakeTransport({"notify-toast": TransportError("TV is busy")}), "hi")


CARD = {"title": " Hello ", "body": "b", "lines": ["a", " b "], "image": "https://example.com/a.png",
        "kind": "alert", "position": "center", "seconds": 0}


def test_overlay_show_normalises_and_sends_json():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    assert notify.overlay_show(fake, CARD) == "Overlay card shown"
    sent = json.loads(payload(fake.commands[0]))
    assert sent == {**CARD, "title": "Hello", "lines": ["a", "b"]}


def test_overlay_hide():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "hidden"})})
    assert notify.overlay_hide(fake) == "Overlay card hidden"
    assert json.loads(payload(fake.commands[0])) == {"hide": True}
    assert notify.overlay_show(fake, {"hide": True}) == "Overlay card hidden"


@pytest.mark.parametrize("card", [
    [], "x", {}, {"title": ""}, {"title": "  "}, {"unknown": 1}, {"title": "x" * 81}, {"body": "x" * 401},
    {"title": 5}, {"title": "a\nb"}, {"lines": "a"}, {"lines": ["a"] * 11}, {"lines": [5]}, {"lines": ["x" * 121]},
    {"image": "ftp://x"}, {"image": "http://a b"}, {"image": "https://x/" + "a" * 500}, {"image": 5},
    {"title": "t", "kind": "loud"}, {"title": "t", "position": "middle"},
    {"title": "t", "seconds": -1}, {"title": "t", "seconds": 301}, {"title": "t", "seconds": 1.5},
    {"title": "t", "seconds": True}, {"hide": False}, {"hide": True, "title": "t"}, {"hide": 1},
])
def test_overlay_rejects_bad_cards_before_transport(card):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        notify.overlay_show(fake, card)
    assert fake.calls == []


def test_overlay_limits_accepted_at_boundary():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    notify.overlay_show(fake, {"title": "x" * 80, "body": "y" * 400, "lines": ["z" * 120] * 10, "seconds": 300})
    assert len(fake.calls) == 1


def test_overlay_too_large_for_grammar():
    fake = FakeTransport()
    with pytest.raises(ValidationError, match="too large"):
        notify.overlay_show(fake, {"title": "t", "lines": ["€" * 120] * 10, "body": "€" * 400, "image": "https://x/" + "a" * 400})
    assert fake.calls == []
