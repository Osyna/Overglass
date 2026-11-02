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


V4_CARD = {"seconds": 0, "theme": {"accent": "#C8F542", "surface": "#0b0d10", "opacity": 0.92, "radius": 0,
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


def test_overlay_v4_theme_regions_and_widgets_pass_through():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    card = V4_CARD
    notify.overlay_show(fake, card)
    sent = json.loads(fake.calls[0].data)
    assert sent["theme"]["accent"] == "#c8f542"  # normalised to lower case
    assert [r["position"] for r in sent["regions"]] == ["top", "right"]
    assert sent["regions"][1]["root"]["children"][2] == {"type": "stat", "label": "Possession", "left": "62%",
                                                         "right": "38%", "fraction": 0.62}
    assert sent["regions"][1]["root"]["children"][3]["axis"] == ["+0.4", "0.0", "-0.4"]
    assert "position" not in sent and "root" not in sent


def test_inspect_overlay_counts_widgets_and_bytes():
    verdict = notify.inspect_overlay(V4_CARD)
    assert verdict["ok"] is True and verdict["widgets"] == 12  # row+4, stack+6
    assert verdict["card"] == notify.check_overlay_request(V4_CARD)
    assert verdict["bytes"] == len(json.dumps(verdict["card"], ensure_ascii=False, separators=(",", ":")).encode())
    with pytest.raises(ValidationError):
        notify.inspect_overlay({"hide": True})


def test_overlay_schema_agrees_with_the_validator():
    """The published JSON Schema must accept what check_overlay_request accepts and refuse what it refuses,
    for the shapes an assistant is likely to produce."""
    jsonschema = pytest.importorskip("jsonschema")
    validator = jsonschema.Draft202012Validator(notify.overlay_schema())
    jsonschema.Draft202012Validator.check_schema(notify.overlay_schema())
    for card in (V4_CARD, {"root": {"type": "text", "text": "Hi"}},
                 {"position": "center", "size": "xl", "seconds": 0, "theme": {"font": "mono"},
                  "root": {"type": "stack", "children": [{"type": "divider"}, {"type": "dot"}, {"type": "clock"},
                                                        {"type": "countdown", "target": "2030-01-01T00:00:00Z"},
                                                        {"type": "progress", "value": 0.5, "tone": "success"},
                                                        {"type": "list", "items": ["a"], "style": "number"},
                                                        {"type": "compare", "segments": [
                                                            {"label": "A", "value": "1", "fraction": 0.5},
                                                            {"label": "B", "value": "1", "fraction": 0.5}]}]}}):
        notify.check_overlay_request(card)
        assert not list(validator.iter_errors(card)), card
    for bad in ({"root": {"type": "stat", "label": "x"}}, {"root": {"type": "text", "text": "x"}, "regions": []},
                {"root": {"type": "section", "title": "x", "icon": "rocket"}}, {"theme": {"accent": "lime"}, "root": {"type": "divider"}},
                {"root": {"type": "meta", "items": []}}, {"root": {"type": "sparkline", "points": [0, 1, 0], "axis": ["a"]}},
                {"position": "middle", "root": {"type": "divider"}}, {"root": {"type": "text", "text": "x", "extra": 1}}):
        with pytest.raises(ValidationError):
            notify.check_overlay_request(bad)
        assert list(validator.iter_errors(bad)), bad


SAFE_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">'
            '<g transform="translate(1, 1)" opacity=".5"><path d="M0 0L10 10Z" fill="#abc" '
            'stroke="currentColor" stroke-width="2" fill-rule="evenodd"/>'
            '<rect x="0" y="0" width="10" height="10" rx="2"/>'
            '<circle cx="5" cy="5" r="2"/><ellipse cx="4" cy="4" rx="2" ry="1"/>'
            '<line x1="0" y1="0" x2="2" y2="2"/><polyline points="0,0 1,1"/>'
            '<polygon points="0,0 1,1 2,0"/></g></svg>')


def test_overlay_new_widgets_and_layout_normalize_before_transport():
    fake = FakeTransport({"notify-overlay": json.dumps({"returnValue": True, "overlay": "shown"})})
    body = {"animation": {"enter": "slide", "exit": "wipe", "duration_ms": 2000},
            "offset": {"x": -1920, "y": 1080}, "behavior": {"on_foreground": "shrink", "ambient_dim": True},
            "root": {"type": "grid", "columns": 3, "gap": 48, "children": [
                {"type": "ticker", "text": " news ", "speed": 200, "tone": "accent"},
                {"type": "qr", "text": " https://example.com ", "size": "l"},
                {"type": "svg", "source": " " + SAFE_SVG + " ", "size": "m"}]}}
    notify.overlay_show(fake, body)
    sent = tree_payload(fake.calls[0])
    assert sent["root"]["children"] == [
        {"type": "ticker", "text": "news", "speed": 200, "tone": "accent"},
        {"type": "qr", "text": "https://example.com", "size": "l"},
        {"type": "svg", "source": SAFE_SVG, "size": "m"}]
    assert sent["animation"] == body["animation"]
    assert sent["offset"] == body["offset"] and sent["behavior"] == body["behavior"]
    assert notify.inspect_overlay(body)["widgets"] == 4


@pytest.mark.parametrize("node", [
    {"type": "grid", "children": [{"type": "divider"}]},
    {"type": "grid", "columns": True, "children": [{"type": "divider"}]},
    {"type": "grid", "columns": 0, "children": [{"type": "divider"}]},
    {"type": "grid", "columns": 4, "children": [{"type": "divider"}]},
    {"type": "grid", "columns": 1, "children": []},
    {"type": "grid", "columns": 1, "children": [{"type": "divider"}] * 21},
    {"type": "grid", "columns": 1, "gap": 49, "children": [{"type": "divider"}]},
    {"type": "grid", "columns": 1, "align": "start", "children": [{"type": "divider"}]},
    {"type": "ticker", "text": ""}, {"type": "ticker", "text": " "},
    {"type": "ticker", "text": "x" * 1001}, {"type": "ticker", "text": "bad\ntext"},
    {"type": "ticker", "text": "x", "speed": 9}, {"type": "ticker", "text": "x", "speed": 201},
    {"type": "ticker", "text": "x", "speed": True}, {"type": "ticker", "text": "x", "tone": "pink"},
    {"type": "qr", "text": ""}, {"type": "qr", "text": "x" * 1001},
    {"type": "qr", "text": "\ud800"}, {"type": "qr", "text": "x", "size": "xl"},
    {"type": "svg", "source": SAFE_SVG, "size": "xl"}, {"type": "svg", "source": None},
])
def test_new_widgets_reject_invalid_fields_before_transport(node):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        notify.overlay_show(fake, {"root": node})
    assert fake.calls == []


def test_qr_codepoint_and_utf8_capacity_boundaries():
    for text in ("x" * 1000, "😀" * 738, "é" * 1000):
        assert notify.check_overlay_request({"root": {"type": "qr", "text": text}})["root"]["text"] == text
    with pytest.raises(ValidationError, match="QR text exceeds 2953 UTF-8 bytes"):
        notify.check_overlay_request({"root": {"type": "qr", "text": "😀" * 739}})
    text = "😀" * 738 + "a"
    assert len(text.encode()) == 2953
    notify.check_overlay_request({"root": {"type": "qr", "text": text}})


@pytest.mark.parametrize("source", [
    "", " ", "<svg>" + " " * 8192 + "</svg>", "<svg><script/></svg>",
    "<svg><style/></svg>", "<svg><foreignObject/></svg>", "<svg><image/></svg>",
    '<svg onload="alert(1)"/>', '<svg style="fill:red"/>', '<svg><use href="#a"/></svg>',
    '<svg><path fill="url(https://evil.test/a)"/></svg>', '<svg xmlns="https://evil.test"/>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"/>',
    '<svg><path xlink:href="https://evil.test"/></svg>', '<!DOCTYPE svg><svg/>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    '<?xml version="1.0"?><svg/>', '<svg><!--comment--></svg>', '<svg><![CDATA[x]]></svg>',
    '<svg>&amp;</svg>', '<svg><text>hello</text></svg>', '<svg>hello</svg>',
    '<svg><g></svg>', '<svg/><svg/>', '<svg><svg/></svg>', '<g/>',
    '<svg><path fill="red" fill="blue"/></svg>', '<svg><path fill=red/></svg>',
    '<svg><path opacity="1.1"/></svg>', '<svg><path opacity="nan"/></svg>',
    '<svg><path transform="url(evil)"/></svg>', '<svg>\n</svg>', '<svg>\u00a0</svg>',
    '<svg/><path/>', '<svg / >', '<svg><path></path extra="x"></svg>',
])
def test_svg_rejects_unsafe_or_malformed_sources(source):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        notify.overlay_show(fake, {"root": {"type": "svg", "source": source}})
    assert fake.calls == []


def test_svg_helper_and_source_length_boundary():
    assert notify._check_svg(" " + SAFE_SVG + " ") == SAFE_SVG
    source = "<svg>" + " " * (8192 - len("<svg></svg>")) + "</svg>"
    assert len(notify._check_svg(source)) == 8192
    assert notify._check_svg("<svg/>") == "<svg/>"


@pytest.mark.parametrize("fields", [
    {"animation": []}, {"animation": {"enter": "zoom"}}, {"animation": {"exit": "zoom"}},
    {"animation": {"duration_ms": -1}}, {"animation": {"duration_ms": 2001}},
    {"animation": {"duration_ms": True}}, {"animation": {"unknown": 1}},
    {"offset": []}, {"offset": {"x": -1921}}, {"offset": {"x": 1921}},
    {"offset": {"y": -1081}}, {"offset": {"y": 1081}}, {"offset": {"x": 1.5}},
    {"offset": {"x": True}}, {"offset": {"z": 0}},
    {"behavior": []}, {"behavior": {"on_foreground": "pause"}},
    {"behavior": {"ambient_dim": 1}}, {"behavior": {"extra": True}},
    {"dim": True}, {"dim": 0.19}, {"dim": 1.01}, {"dim": float("nan")},
    {"compact": 1},
])
def test_card_options_validate_single_and_region_cards(fields):
    root = {"type": "divider"}
    for body in ({"root": root, **fields}, {"regions": [{"position": "center", "root": root, **fields}]}):
        with pytest.raises(ValidationError):
            notify.check_overlay_request(body)


def test_card_option_defaults_and_boundaries_are_preserved():
    for fields in ({"animation": {}, "offset": {}, "behavior": {}},
                   {"animation": {"enter": "none", "exit": "fade", "duration_ms": 0},
                    "offset": {"x": 1920, "y": -1080}, "behavior": {"on_foreground": "keep", "ambient_dim": False},
                    "dim": 0.2, "compact": False}):
        body = {"root": {"type": "divider"}, **fields}
        assert notify.check_overlay_request(body) == body
        region = {"position": "center", **body}
        assert notify.check_overlay_request({"regions": [region]}) == {"regions": [region]}


def test_timeline_normalizes_shorthand_regions_and_counts_all_frames():
    body = {"theme": {"accent": "#ABCDEF"}, "behavior": {"on_foreground": "hide"},
            "timeline": [{"seconds": 1, "card": {"title": " First "}},
                         {"seconds": 300, "card": {"regions": [
                             {"position": "top", "animation": {"enter": "fade"},
                              "offset": {"x": 0}, "root": {"type": "ticker", "text": " Second "}},
                             {"position": "right", "root": {"type": "qr", "text": "data"}}]}}]}
    inspected = notify.inspect_overlay(body)
    assert inspected["widgets"] == 6  # four shorthand widgets, then two region roots
    assert inspected["card"]["theme"] == {"accent": "#abcdef"}
    assert inspected["card"]["timeline"][0]["card"]["root"]["children"][0]["children"][1]["text"] == "First"
    assert inspected["bytes"] == len(json.dumps(inspected["card"], ensure_ascii=False, separators=(",", ":")).encode())
    assert notify.check_overlay_request(inspected["card"]) == inspected["card"]


def test_timeline_global_widget_cap_accepts_eighty_and_rejects_eighty_one():
    grid = {"type": "grid", "columns": 1, "children": [{"type": "divider"}] * 19}
    body = {"timeline": [{"seconds": 1, "card": {"root": grid}} for _ in range(4)]}
    assert notify.inspect_overlay(body)["widgets"] == 80
    body["timeline"][0]["card"] = {"root": {**grid, "children": grid["children"] + [{"type": "divider"}]}}
    with pytest.raises(ValidationError, match="at most 80 widgets"):
        notify.check_overlay_request(body)


def test_timeline_global_byte_cap_applies_across_frames():
    root = {"type": "grid", "columns": 3, "children": [{"type": "list", "items": ["x" * 120] * 10}] * 20}
    with pytest.raises(ValidationError, match="too large"):
        notify.check_overlay_request({"timeline": [{"seconds": 1, "card": {"root": root}}] * 2})


@pytest.mark.parametrize("body", [
    {"timeline": []}, {"timeline": [{"seconds": 1, "card": {"root": {"type": "divider"}}}] * 5},
    {"timeline": [{"seconds": 0, "card": {"root": {"type": "divider"}}}]},
    {"timeline": [{"seconds": 301, "card": {"root": {"type": "divider"}}}]},
    {"timeline": [{"seconds": True, "card": {"root": {"type": "divider"}}}]},
    {"timeline": [{"seconds": 1, "card": {"hide": True}}]},
    {"timeline": [{"seconds": 1, "card": {"action": "runtime", "hidden": True}}]},
    {"timeline": [{"seconds": 1, "card": {"timeline": [{"seconds": 1, "card": {"title": "x"}}]}}]},
    {"timeline": [{"seconds": 1, "card": {"root": {"type": "divider"}}, "extra": True}]},
    {"timeline": [{"seconds": 1, "card": {"title": "x"}}], "root": {"type": "divider"}},
    {"timeline": [{"seconds": 1, "card": {"title": "x"}}], "regions": []},
    {"timeline": [{"seconds": 1, "card": {"title": "x"}}], "position": "center"},
    {"timeline": [{"seconds": 1, "card": {"title": "x"}}], "animation": {}},
])
def test_timeline_rejects_ambiguous_nested_or_invalid_frames(body):
    with pytest.raises(ValidationError):
        notify.check_overlay_request(body)


def test_runtime_envelope_is_separate_from_design_validation():
    for body in ({"action": "runtime"}, {"action": "runtime", "dim": 0.2, "compact": False, "hidden": True},
                 {"action": "runtime", "dim": 1, "compact": True, "hidden": False}):
        assert notify.check_overlay_request(body) == body
        with pytest.raises(ValidationError, match="Nothing to check"):
            notify.inspect_overlay(body)
    for body in ({"action": "runtime", "hidden": 1}, {"action": "runtime", "dim": False},
                 {"action": "runtime", "compact": "yes"}, {"action": "runtime", "dim": 0},
                 {"action": "runtime", "root": {"type": "divider"}},
                 {"action": "runtime", "timeline": []}, {"action": "runtime", "behavior": {}}):
        with pytest.raises(ValidationError):
            notify.check_overlay_request(body)


def test_public_schema_covers_new_nodes_layout_and_timeline_but_not_runtime():
    jsonschema = pytest.importorskip("jsonschema")
    schema = notify.overlay_schema()
    validator = jsonschema.Draft202012Validator(schema)
    jsonschema.Draft202012Validator.check_schema(schema)
    root = {"type": "grid", "columns": 1, "children": [
        {"type": "ticker", "text": "news", "speed": 10, "tone": "info"},
        {"type": "qr", "text": "data", "size": "s"}, {"type": "svg", "source": SAFE_SVG}]}
    card = {"root": root, "animation": {"enter": "wipe", "duration_ms": 0},
            "offset": {"x": -1920, "y": 1080}, "behavior": {"on_foreground": "shrink", "ambient_dim": True}}
    for body in (card, {"regions": [{"position": "top", **card}]},
                 {"timeline": [{"seconds": 1, "card": card}, {"seconds": 300, "card": {"root": root}}]}):
        assert not list(validator.iter_errors(body))
        assert notify.check_overlay_request(body) == body
    for body in ({"action": "runtime", "hidden": True}, {**card, "dim": 0.5},
                 {"root": root, "animation": {"duration_ms": 2001}},
                 {"root": root, "offset": {"x": 1921}},
                 {"root": root, "behavior": {"ambient_dim": 1}},
                 {"timeline": [{"seconds": 0, "card": card}]},
                 {"timeline": [{"seconds": 1, "card": {"timeline": [{"seconds": 1, "card": card}]}}]}):
        assert list(validator.iter_errors(body))


def test_timeline_keeps_per_tree_depth_and_per_frame_region_limits():
    root = {"type": "divider"}
    for _ in range(notify.MAX_TREE_DEPTH):
        root = {"type": "grid", "columns": 1, "children": [root]}
    frame = {"regions": [{"position": position, "root": root}
                         for position in ("top", "bottom", "left", "right")]}
    body = {"timeline": [{"seconds": 1, "card": frame}]}
    assert notify.inspect_overlay(body)["widgets"] == 4 * (notify.MAX_TREE_DEPTH + 1)
    frame["regions"].append({"position": "center", "root": {"type": "divider"}})
    with pytest.raises(ValidationError, match="regions needs"):
        notify.check_overlay_request(body)
    deep = {"type": "grid", "columns": 1, "children": [root]}
    with pytest.raises(ValidationError, match="nest at most"):
        notify.check_overlay_request({"timeline": [{"seconds": 1, "card": {"root": deep}}]})


@pytest.mark.parametrize("node", [
    {"type": "compare", "segments": [{"label": "a", "value": "1", "fraction": 0.5, "extra": True},
                                     {"label": "b", "value": "1", "fraction": 0.5}]},
    {"type": "meta", "items": [{"label": "a", "value": "b", "extra": True}]},
])
def test_nested_widget_items_reject_unknown_fields_like_public_schema(node):
    with pytest.raises(ValidationError, match="Unknown"):
        notify.check_overlay_request({"root": node})
