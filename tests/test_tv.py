import base64
import json

import pytest

from tests.fakes import FakeTransport
from webos_foundry import tv
from webos_foundry.config import Config
from webos_foundry.errors import NotPairedError, TransportError, ValidationError

POWER = {"returnValue": True, "state": "Active"}
FOREGROUND = {"returnValue": True, "appId": "com.webos.app.hdmi2"}
HOME = {"main": "/usr/palm/applications/com.webos.app.home/index.html"}
THERMAL = {"temperature_millicelsius": 66000, "temperature_source": "soc"}
VOLUME = {"returnValue": True, "volumeStatus": {"volume": 12, "maxVolume": 100, "muteStatus": False}}


def raw(power=POWER, foreground=FOREGROUND, home=HOME, thermal=THERMAL, volume=VOLUME):
    docs = "\n".join(json.dumps(d) for d in (power, foreground, home, thermal))
    return docs + "\n\n@@@\n" + (json.dumps(volume) if volume is not None else "")


def status(**kw):
    return tv.get_status(FakeTransport({"status": raw(**kw)}))


def test_status_hdmi_on():
    assert status() == {"power": "on", "raw_power_state": "Active", "app_id": "com.webos.app.hdmi2", "source": "HDMI 2",
                        "is_luma": False, "temperature_c": 66.0, "temperature_source": "soc", "volume": 12, "muted": False}


@pytest.mark.parametrize("app, home, source, luma", [
    ("com.ecklf.luma", HOME, "Luma", True),
    ("com.webos.app.home", {"main": "/x/luma"}, "Luma", True),
    ("com.webos.app.home", HOME, "LG Home", False),
    ("com.webos.app.hdmi5", HOME, "com.webos.app.hdmi5", False),
    ("com.example.app", HOME, "com.example.app", False),
])
def test_status_sources(app, home, source, luma):
    result = status(foreground={"returnValue": True, "appId": app}, home=home)
    assert (result["source"], result["is_luma"]) == (source, luma)


def test_status_standby_has_no_volume():
    result = status(power={"returnValue": True, "state": "Active Standby"}, volume=None)
    assert (result["power"], result["source"], result["volume"], result["muted"]) == ("off", "Off", None, None)


def test_status_unspaced_power_names_and_unknown():
    assert status(power={"returnValue": True, "state": "ScreenSaver"})["power"] == "on"
    assert status(power={"returnValue": True, "state": "ActiveStandby"}, volume=None)["power"] == "off"
    assert status(power={"returnValue": True, "state": "Suspend"})["power"] == "unknown"


@pytest.mark.parametrize("kwargs", [
    {"volume": None},  # volume missing while on
    {"volume": {"returnValue": True, "volumeStatus": {"volume": 101, "maxVolume": 100, "muteStatus": False}}},
    {"volume": {"returnValue": True, "volumeStatus": {"volume": 1, "maxVolume": 100, "muteStatus": 0}}},
    {"power": {"returnValue": False}},
    {"foreground": {"returnValue": False}},
])
def test_status_rejects_bad_data(kwargs):
    with pytest.raises(ValueError):
        status(**kwargs)


def test_status_wrong_document_count():
    with pytest.raises(ValueError):
        tv.parse_status('{"a":1}\n@@@\n{}')


@pytest.mark.parametrize("thermal", [{"temperature_millicelsius": None, "temperature_source": None},
                                     {"temperature_millicelsius": 500, "temperature_source": "soc"},
                                     {"temperature_millicelsius": True, "temperature_source": "soc"}, []])
def test_bad_temperature_hides_only_temperature(thermal):
    result = status(thermal=thermal)
    assert result["temperature_c"] is None and result["temperature_source"] is None and result["power"] == "on"


DETAILS = {"lux": 12, "panel_hours": 100, "panel_temperature_c": None, "pixel_refresher": {"a": 1}, "power_on_reason": "x",
           "power_history": [], "signal": {}, "sleep_timer": "off", "usage_today": []}


def test_details_ok_and_malformed():
    assert tv.get_details(FakeTransport({"details": json.dumps(DETAILS)})) == DETAILS
    for bad in ({**DETAILS, "lux": "1"}, {k: v for k, v in DETAILS.items() if k != "lux"}, [], {**DETAILS, "lux": True}):
        with pytest.raises(RuntimeError):
            tv.get_details(FakeTransport({"details": json.dumps(bad)}))
    with pytest.raises(RuntimeError):
        tv.get_details(FakeTransport({"details": "oops"}))


def item(key=("sound", "aiSound"), **kw):
    base = {"category": key[0], "key": key[1], "value": "on", "values": ["on", "off"], "available": True, "context": {"input": "x"}}
    return {**base, **kw}


def test_settings_sorted_and_labelled():
    reply = json.dumps([item(("sound", "aiSound")), item(("aiPicture", "ai_Picture"))])
    items = tv.get_settings(FakeTransport({"settings-list": reply}))
    assert [i["key"] for i in items] == ["ai_Picture", "aiSound"] and items[0]["label"] == "AI Picture Pro"


@pytest.mark.parametrize("bad", [item(("sound", "volume")), item(value=1), item(values="on"), item(values=[1]),
                                 item(available="yes"), item(context=[]), "x"])
def test_settings_malformed(bad):
    with pytest.raises(RuntimeError):
        tv.get_settings(FakeTransport({"settings-list": json.dumps([bad])}))
    with pytest.raises(RuntimeError):
        tv.get_settings(FakeTransport({"settings-list": json.dumps({"not": "a list"})}))


def test_set_setting_sends_value_and_context_and_labels_reply():
    fake = FakeTransport({"settings-set": json.dumps("aiSound = on (persists on the TV until changed)")})
    message = tv.set_setting(fake, "sound", "aiSound", "on", {"input": "x"})
    assert message == "AI Sound: aiSound = on (persists on the TV until changed)"
    verb, category, key, payload = fake.commands[0].split(" ")
    assert (verb, category, key) == ("settings-set", "sound", "aiSound")
    assert json.loads(base64.b64decode(payload)) == {"value": "on", "context": {"input": "x"}}


def test_set_setting_accepts_message_object_as_is():
    fake = FakeTransport({"settings-set": json.dumps({"message": "AI Sound: done"})})
    assert tv.set_setting(fake, "sound", "aiSound", "on", {}) == "AI Sound: done"


@pytest.mark.parametrize("args", [("sound", "nope", "on", {}), ("sound", "aiSound", "", {}), ("sound", "aiSound", 1, {}),
                                  ("sound", "aiSound", "on", []), ("sound", "aiSound", "on", {"a": 1}),
                                  ("sound", "aiSound", "x" * 4000, {})])
def test_set_setting_validates_before_transport(args):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        tv.set_setting(fake, *args)
    assert fake.calls == []


def test_set_setting_malformed_reply():
    with pytest.raises(RuntimeError):
        tv.set_setting(FakeTransport({"settings-set": "12"}), "sound", "aiSound", "on", {})


def test_remote_actions_and_validation():
    fake = FakeTransport({"remote": json.dumps({"message": "Sent home"})})
    assert tv.remote(fake, "home") == "Sent home"
    assert tv.remote(fake, "hdmi", 2) == "Sent home" and fake.commands == ["remote home", "remote hdmi 2"]
    for args in (("nope",), ("hdmi",), ("hdmi", 9), ("hdmi", "2"), ("home", 1)):
        with pytest.raises(ValidationError):
            tv.remote(fake, *args)
    assert len(fake.calls) == 2
    with pytest.raises(RuntimeError):
        tv.remote(FakeTransport({"remote": "5"}), "home")


@pytest.mark.parametrize("value", [0, 40, 41, 100])
def test_absolute_volume_sends_one_canonical_command(value):
    fake = FakeTransport({"remote": json.dumps("Volume %d" % value)})
    assert tv.remote(fake, "volume", value) == "Volume %d" % value
    assert fake.commands == ["remote volume %d" % value]
    assert fake.calls[0].timeout == 45


@pytest.mark.parametrize("value", [None, True, False, 1.0, 1.5, -1, 101, "40", "40; id", "40\n", [], {}])
def test_absolute_volume_rejects_before_transport(value):
    fake = FakeTransport()
    with pytest.raises(ValidationError, match="Volume must be the integer 0-100"):
        tv.remote(fake, "volume", value)
    assert fake.calls == []


def test_remote_transport_errors_propagate():
    with pytest.raises(TransportError):
        tv.remote(FakeTransport({"remote": TransportError("down")}), "home")


def test_wake_sends_magic_packet_without_transport(monkeypatch):
    sent = []
    monkeypatch.setattr(tv, "_send_udp", lambda packet, address: sent.append((packet, address)))
    fake = FakeTransport()
    config = Config(tv_host="h", mac="aa:bb:cc:dd:ee:ff", broadcast="192.168.1.255:9")
    assert tv.remote(fake, "wake", config=config).startswith("Wake packet sent")
    assert fake.calls == []
    packet, address = sent[0]
    assert packet == b"\xff" * 6 + bytes.fromhex("aabbccddeeff") * 16 and address == ("192.168.1.255", 9)


def test_wake_defaults_and_errors(monkeypatch):
    sent = []
    monkeypatch.setattr(tv, "_send_udp", lambda packet, address: sent.append(address))
    tv.remote(FakeTransport(), "wake", config=Config(tv_host="h", mac="AA-BB-CC-DD-EE-FF"))
    assert sent == [("255.255.255.255", 9)]
    with pytest.raises(NotPairedError, match="MAC"):
        tv.remote(FakeTransport(), "wake", config=Config(tv_host="h"))
    with pytest.raises(ValidationError):
        tv.remote(FakeTransport(), "wake", config=Config(tv_host="h", mac="nonsense"))
    with pytest.raises(ValidationError):
        tv.remote(FakeTransport(), "wake", config=Config(tv_host="h", mac="AA:BB:CC:DD:EE:FF", broadcast="nope"))
    assert len(sent) == 1
