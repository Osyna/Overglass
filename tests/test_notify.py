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


SHORTHAND = {"title": " Hello ", "body": "b", "lines": ["a", " b "], "image": "https://example.com/a.png",
             "kind": "alert", "position": "center", "seconds": 0}
COMPILED_ROOT = {"type": "stack", "gap": 12, "children": [
    {"type": "row", "gap": 14, "align": "center", "children": [
        {"type": "dot", "tone": "alert"},
        {"type": "text", "text": "Hello", "size": "l", "weight": "strong"},
    ]},
    {"type": "text", "text": "b", "color": "fg-2"},
    {"type": "list", "items": ["a", "b"]},
    {"type": "image", "src": "https://example.com/a.png"},
]}


def tree_payload(call):
    return json.loads(call.data.decode())


def test_overlay_show_compiles_shorthand_into_a_tree_and_sends_raw_json():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    assert notify.overlay_show(fake, SHORTHAND) == "Overlay card shown"
    assert tree_payload(fake.calls[0]) == {"position": "center", "seconds": 0, "root": COMPILED_ROOT}


def test_overlay_show_passes_a_root_tree_through_unchanged():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    card = {"size": "l", "root": {"type": "text", "text": "Hi", "size": "xl"}}
    assert notify.overlay_show(fake, card) == "Overlay card shown"
    assert tree_payload(fake.calls[0]) == card


def test_overlay_show_passes_v3_widgets_through_unchanged():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    card = {"root": {"type": "stack", "children": [
        {"type": "image", "src": "https://example.com/crest.png", "shape": "circle"},
        {"type": "compare", "segments": [
            {"label": "SRB", "value": "51%", "fraction": 0.51, "tone": "success"},
            {"label": "Draw", "value": "30%", "fraction": 0.30},
            {"label": "AND", "value": "19%", "fraction": 0.19},
        ]},
        {"type": "sparkline", "points": [-0.2, 0.1, 0.3, -0.1, 0.4], "tone": "info"},
    ]}}
    assert notify.overlay_show(fake, card) == "Overlay card shown"
    assert tree_payload(fake.calls[0]) == card


def test_overlay_hide():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "hidden"})})
    assert notify.overlay_hide(fake) == "Overlay card hidden"
    assert tree_payload(fake.calls[0]) == {"hide": True}
    assert notify.overlay_show(fake, {"hide": True}) == "Overlay card hidden"


@pytest.mark.parametrize("card", [
    [], "x", {}, {"title": ""}, {"title": "  "}, {"unknown": 1}, {"title": "x" * 81}, {"body": "x" * 401},
    {"title": 5}, {"title": "a\nb"}, {"lines": "a"}, {"lines": ["a"] * 11}, {"lines": [5]}, {"lines": ["x" * 121]},
    {"image": "ftp://x"}, {"image": "http://a b"}, {"image": "https://x/" + "a" * 500}, {"image": 5},
    {"title": "t", "kind": "loud"}, {"title": "t", "position": "middle"}, {"title": "t", "size": "xxl"},
    {"title": "t", "seconds": -1}, {"title": "t", "seconds": 301}, {"title": "t", "seconds": 1.5},
    {"title": "t", "seconds": True}, {"hide": False}, {"hide": True, "title": "t"}, {"hide": 1},
    {"title": "t", "root": {"type": "text", "text": "x"}},  # root and shorthand are mutually exclusive
    {"root": {"type": "nope"}}, {"root": [1]}, {"root": "x"},
    {"root": {"type": "stack", "children": []}}, {"root": {"type": "row", "children": [{"type": "text", "text": "x"}] * 11}},
    {"root": {"type": "text"}}, {"root": {"type": "text", "text": "x" * 401}},
    {"root": {"type": "image", "src": "ftp://x"}}, {"root": {"type": "badge", "text": "x", "tone": "loud"}},
    {"root": {"type": "progress", "value": 1.5}}, {"root": {"type": "progress"}},
    {"root": {"type": "countdown", "target": "not a date"}}, {"root": {"type": "countdown"}},
    {"root": {"type": "list", "items": []}}, {"root": {"type": "list", "items": ["x"] * 11}},
    {"root": {"type": "image", "src": "https://x/a.png", "shape": "round"}},
    {"root": {"type": "compare", "segments": []}}, {"root": {"type": "compare", "segments": [{"label": "a"}]}},
    {"root": {"type": "compare", "segments": [{"label": "a", "value": "1", "fraction": 1.5},
                                               {"label": "b", "value": "2", "fraction": 0.5}]}},
    {"root": {"type": "compare", "segments": [{"label": "a", "value": "1", "fraction": 0.5}]}},  # only 1 segment
    {"root": {"type": "sparkline", "points": [0.1, 0.2]}}, {"root": {"type": "sparkline", "points": [2] * 5}},
    {"root": {"type": "sparkline", "points": ["x"] * 5}},
    {"root": {"type": "stack", "children": [{"type": "stack", "children": [{"type": "stack", "children": [
        {"type": "stack", "children": [{"type": "stack", "children": [{"type": "stack", "children": [
            {"type": "text", "text": "x"}]}]}]}]}]}]}},  # depth 6
    {"root": {"type": "stack", "children": [{"type": "text", "text": "x"}] * 21}},  # over the 20-children-per-stack cap
    {"root": {"type": "row", "children": [  # 89 nodes via nested rows: exceeds the 80-widget-total cap
        {"type": "row", "children": [{"type": "text", "text": "x"}] * 10}] * 8}},
    {"root": {"type": "section", "title": ""}, "theme": {"accent": "lime"}},  # theme colours are #rrggbb only
    {"root": {"type": "text", "text": "x"}, "theme": {"opacity": 0.1}},
    {"root": {"type": "text", "text": "x"}, "theme": {"radius": 40}},
    {"root": {"type": "text", "text": "x"}, "theme": {"scale": 2}},
    {"root": {"type": "text", "text": "x"}, "theme": {"font": "comic"}},
    {"root": {"type": "text", "text": "x"}, "theme": {"glow": True}},
    {"root": {"type": "text", "text": "x"}, "theme": []},
    {"regions": []}, {"regions": [{"position": "top", "root": {"type": "text", "text": "x"}}] * 5},
    {"regions": [{"position": "top", "root": {"type": "text", "text": "x"}},
                 {"position": "top", "root": {"type": "text", "text": "y"}}]},  # duplicate position
    {"regions": [{"root": {"type": "text", "text": "x"}}]},  # position required per region
    {"regions": [{"position": "top", "root": {"type": "text", "text": "x"}}], "position": "top"},  # not both
    {"regions": [{"position": "top", "root": {"type": "text", "text": "x"}}, {"position": "right", "root": {
        "type": "row", "children": [{"type": "row", "children": [{"type": "text", "text": "x"}] * 10}] * 8}}]},  # 80 cap spans regions
    {"root": {"type": "section", "icon": "wand", "title": "x"}}, {"root": {"type": "section", "title": "x" * 41}},
    {"root": {"type": "event", "time": "1", "text": "x", "tone": "pink"}}, {"root": {"type": "event", "text": "x"}},
    {"root": {"type": "stat", "label": "a", "left": "1", "right": "2", "fraction": 1.2}},
    {"root": {"type": "stat", "label": "a", "left": "1", "fraction": 0.5}},
    {"root": {"type": "status", "label": "api", "state": "up"}},
    {"root": {"type": "meta", "items": []}}, {"root": {"type": "meta", "items": [{"label": "a"}]}},
    {"root": {"type": "meta", "items": [{"label": "a", "value": "b", "icon": "nope"}]}},
    {"root": {"type": "clock", "format": "stardate"}},
    {"root": {"type": "sparkline", "points": [0, 0.5, 1], "axis": ["+1", "0"]}},
    {"root": {"type": "image", "src": "https://x/a.png", "size": "xl"}},
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
    one_list = {"type": "list", "items": ["x" * 120] * 10}
    group = {"type": "stack", "children": [one_list] * 20}
    with pytest.raises(ValidationError, match="too large"):
        notify.overlay_show(fake, {"root": {"type": "stack", "children": [group, group]}})
    assert fake.calls == []


def test_overlay_v4_theme_regions_and_widgets_pass_through():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    card = {"seconds": 0, "theme": {"accent": "#C8F542", "surface": "#0b0d10", "opacity": 0.92, "radius": 0,
                                     "scale": 1.1, "font": "condensed"},
            "regions": [
                {"position": "top", "size": "full", "root": {"type": "row", "gap": 24, "children": [
                    {"type": "image", "src": "https://example.com/a.png", "shape": "circle", "size": "s"},
                    {"type": "text", "text": "0 - 0", "size": "xl", "weight": "strong", "color": "accent"},
                    {"type": "clock", "format": "time", "label": "1st half"},
                    {"type": "badge", "text": "LIVE", "tone": "accent"}]}},
                {"position": "right", "size": "s", "root": {"type": "stack", "children": [
                    {"type": "section", "title": "Live events", "icon": "bolt", "action": "All events"},
                    {"type": "event", "time": "08:17", "text": "Yellow card", "icon": "card", "tone": "warning"},
                    {"type": "stat", "label": "Possession", "left": "62%", "right": "38%", "fraction": 0.62},
                    {"type": "sparkline", "points": [0.2, -0.1, 0.4], "axis": ["+0.4", "0.0", "-0.4"]},
                    {"type": "meta", "items": [{"label": "Venue", "value": "Somewhere", "icon": "pin"}]},
                    {"type": "status", "label": "Match Data API", "state": "online", "detail": "112 ms"}]}}]}
    notify.overlay_show(fake, card)
    sent = json.loads(fake.calls[0].data)
    assert sent["theme"]["accent"] == "#c8f542"  # normalised to lower case
    assert [r["position"] for r in sent["regions"]] == ["top", "right"]
    assert sent["regions"][1]["root"]["children"][2] == {"type": "stat", "label": "Possession", "left": "62%",
                                                         "right": "38%", "fraction": 0.62}
    assert sent["regions"][1]["root"]["children"][3]["axis"] == ["+0.4", "0.0", "-0.4"]
    assert "position" not in sent and "root" not in sent
