import base64
import binascii
import copy
import json
import stat
import zlib

import pytest

from tests.fakes import FakeTransport
from webos_foundry import bindings, designs, rotations, themes, webhooks
from webos_foundry.errors import ValidationError


CARD = {"root": {"type": "text", "text": "Initial"}}
SOURCE = {"kind": "json", "url": "https://example.com/data", "path": "value"}


def bound(card=None, target="/root/text", source=None):
    card = copy.deepcopy(CARD if card is None else card)
    card["bindings"] = [{"target": target, "source": copy.deepcopy(SOURCE if source is None else source)}]
    return card


def test_themes_normalize_persist_and_delete_privately(tmp_path):
    theme = themes.save("Evening", {"accent": "#ABCDEF", "radius": 0}, tmp_path)
    assert theme == {"accent": "#abcdef", "radius": 0}
    assert themes.load(tmp_path) == {"Evening": theme}
    assert stat.S_IMODE((tmp_path / themes.FILE).stat().st_mode) == 0o600
    with pytest.raises(ValidationError):
        themes.save("Evening", {"accent": "url(javascript:bad)"}, tmp_path)
    assert themes.load(tmp_path) == {"Evening": theme}
    themes.delete("Evening", tmp_path)
    assert themes.load(tmp_path) == {}


def test_history_bounded_unique_and_restore_records_current(tmp_path):
    for index in range(104):
        designs.save("A", {"root": {"type": "text", "text": str(index)}}, tmp_path)
    versions = designs.history("A", tmp_path)
    assert len(versions) == len({version["id"] for version in versions}) == 100
    assert versions[0]["card"]["root"]["text"] == "3"
    assert versions[-1]["card"]["root"]["text"] == "102"
    assert all(version["created_at"] for version in versions)
    restored = designs.restore("A", versions[0]["id"], tmp_path)
    assert restored["root"]["text"] == "3"
    assert designs.history("A", tmp_path)[-1]["card"]["root"]["text"] == "103"
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    with pytest.raises(ValidationError):
        designs.restore("A", "unknown", tmp_path)
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before
    assert json.loads((tmp_path / designs.FILE).read_text()) == designs.load(tmp_path)


def test_rename_moves_history_and_rejects_collisions_without_loss(tmp_path):
    designs.save("A", CARD, tmp_path)
    designs.save("A", {"root": {"type": "text", "text": "Updated"}}, tmp_path)
    versions = designs.history("A", tmp_path)
    designs.rename("A", "B", tmp_path)
    assert "A" not in designs.load(tmp_path)
    assert designs.history("B", tmp_path) == versions
    designs.save("A", CARD, tmp_path)
    with pytest.raises(ValidationError, match="already"):
        designs.rename("B", "A", tmp_path)
    assert designs.history("B", tmp_path) == versions


def test_failed_design_commit_rolls_back_both_stores(tmp_path, monkeypatch):
    designs.save("A", CARD, tmp_path)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    original = designs.os.replace
    calls = []

    def fail_second(source, target):
        calls.append(target)
        if len(calls) >= 2:
            raise OSError("disk error")
        return original(source, target)

    monkeypatch.setattr(designs.os, "replace", fail_second)
    with pytest.raises(OSError, match="disk error"):
        designs.save("A", {"root": {"type": "text", "text": "Lost"}}, tmp_path)
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before


def test_binding_save_does_not_fetch_and_show_resolves_privately(tmp_path, monkeypatch):
    source = {**SOURCE, "kind": "homeassistant", "token": "private-token", "allow_private": True}
    calls = []

    def fetch(url, headers=None, allow_private=False):
        calls.append((url, headers, allow_private))
        return {"value": 21.5}

    monkeypatch.setattr(bindings.datafetch, "fetch_json", fetch)
    design = designs.save("Temperature", bound(source=source), tmp_path)
    assert calls == []
    assert design["bindings"][0]["source"]["token"] == "private-token"
    transport = FakeTransport({"notify-overlay": '{"returnValue": true, "overlay": "shown"}'})
    designs.show(transport, "Temperature", tmp_path)
    sent = json.loads(transport.calls[0].data)
    assert sent["root"]["text"] == "21.5"
    assert "bindings" not in sent and "private-token" not in json.dumps(sent)
    assert calls == [(SOURCE["url"], {"Authorization": "Bearer private-token"}, True)]
    assert designs.load(tmp_path)["Temperature"] == design


@pytest.mark.parametrize("target", ["/root/type", "/root/src", "/root/__proto__", "/seconds", "/root/children", "/root/text/constructor"])
def test_bindings_cannot_change_structure_or_urls(target):
    with pytest.raises(ValidationError, match="target"):
        designs.check_design(bound(target=target))


@pytest.mark.parametrize("source", [
    {**SOURCE, "url": "file:///etc/passwd"},
    {**SOURCE, "url": "https://user:password@example.com"},
    {**SOURCE, "path": "__proto__.secret"},
    {**SOURCE, "allow_private": "true"},
    {**SOURCE, "kind": "homeassistant"},
])
def test_bindings_validate_source_boundaries(source):
    with pytest.raises(ValidationError):
        designs.check_design(bound(source=source))


def test_binding_failure_only_uses_explicit_validated_fallback(monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("Data endpoint unavailable")

    monkeypatch.setattr(bindings.datafetch, "fetch_json", fail)
    with pytest.raises(ValidationError, match="could not resolve"):
        bindings.resolve(bound())
    design = bound()
    design["bindings"][0]["fallback"] = "Offline"
    assert bindings.resolve(design)["root"]["text"] == "Offline"
    numeric = bound({"root": {"type": "progress", "value": 0.5}}, "/root/value")
    numeric["bindings"][0]["fallback"] = 2
    with pytest.raises(ValidationError):
        designs.check_design(numeric)


def test_binding_resolved_value_gets_final_validation(monkeypatch):
    monkeypatch.setattr(bindings.datafetch, "fetch_json", lambda *args, **kwargs: {"value": 4})
    design = bound({"root": {"type": "progress", "value": 0.5}}, "/root/value")
    with pytest.raises(ValidationError, match="0-1"):
        bindings.resolve(design)


@pytest.mark.parametrize("root,target", [
    ({"type": "progress", "value": 0.5}, "/root/value"),
    ({"type": "stat", "label": "Temperature", "left": "18", "right": "30", "fraction": 0.5}, "/root/fraction"),
    ({"type": "compare", "segments": [
        {"label": "A", "value": "18", "fraction": 0.5},
        {"label": "B", "value": "30", "fraction": 0.5}]}, "/root/segments/0/fraction"),
    ({"type": "sparkline", "points": [0, 0.5, 1]}, "/root/points/1"),
])
@pytest.mark.parametrize("state,expected", [("0.25", 0.25), ("1e-1", 0.1), ("-0", 0.0)])
def test_ha_numeric_state_strings_bind_only_to_numeric_targets(monkeypatch, root, target, state, expected):
    source = {"kind": "homeassistant", "url": "https://example.com/api/states/sensor.temperature",
              "path": "state", "token": "secret"}
    monkeypatch.setattr(bindings.datafetch, "fetch_json", lambda *args, **kwargs: {"state": state})
    resolved = bindings.resolve(bound({"root": root}, target, source))
    assert bindings.datafetch.scalar_at(resolved, target) == expected
    assert isinstance(bindings.datafetch.scalar_at(resolved, target), float)
    assert bindings.resolve(bound(source=source))["root"]["text"] == state


@pytest.mark.parametrize("state", [
    "unknown", "unavailable", "NaN", "Infinity", "1e999", "0x10", "+0.5", ".5", "01", " 0.5", "0.5 ", "2",
])
def test_numeric_state_binding_rejects_invalid_nonfinite_and_out_of_range_values(monkeypatch, state):
    monkeypatch.setattr(bindings.datafetch, "fetch_json", lambda *args, **kwargs: {"value": state})
    with pytest.raises(ValidationError):
        bindings.resolve(bound({"root": {"type": "progress", "value": 0.5}}, "/root/value"))


def test_status_state_binding_and_webhook_use_literal_validated_enum(monkeypatch):
    design = bound({"root": {"type": "status", "label": "Sensor", "state": "unknown"}}, "/root/state")
    monkeypatch.setattr(bindings.datafetch, "fetch_json", lambda *args, **kwargs: {"value": "online"})
    assert bindings.resolve(design)["root"]["state"] == "online"
    assert bindings.apply_values(design, {"/root/state": "offline"})["root"]["state"] == "offline"
    monkeypatch.setattr(bindings.datafetch, "fetch_json", lambda *args, **kwargs: {"value": "on"})
    with pytest.raises(ValidationError):
        bindings.resolve(design)
    with pytest.raises(ValidationError):
        bindings.apply_values(design, {"/root/state": "on"})


def test_timeline_design_history_and_binding_targets(tmp_path, monkeypatch):
    card = {"timeline": [{"seconds": 2, "card": CARD}, {"seconds": 3, "card": CARD}]}
    card = bound(card, "/timeline/1/card/root/text")
    designs.save("Sequence", card, tmp_path)
    assert len(designs.load(tmp_path)["Sequence"]["timeline"]) == 2
    monkeypatch.setattr(bindings.datafetch, "fetch_json", lambda *args, **kwargs: {"value": "Next"})
    assert bindings.resolve(card)["timeline"][1]["card"]["root"]["text"] == "Next"


def test_design_webhook_applies_only_declared_scalar_targets(tmp_path, monkeypatch):
    design = bound({"root": {"type": "stack", "children": [
        {"type": "text", "text": "Live"}, {"type": "text", "text": "Hello {{name}}"}]}}, "/root/children/0/text")
    designs.save("Live", design, tmp_path)
    token = webhooks.create(design="Live", label="Live data", config_dir_override=tmp_path)
    entry = webhooks.resolve(token, tmp_path)
    assert entry == {"design": "Live", "label": "Live data"}
    monkeypatch.setattr(bindings.datafetch, "fetch_json", lambda *args, **kwargs: pytest.fail("overridden binding fetched"))
    card = webhooks.render(entry, {"/root/children/0/text": 42, "name": "Ada"}, tmp_path)
    assert card["root"]["children"][0]["text"] == "42"
    assert card["root"]["children"][1]["text"] == "Hello Ada"
    assert "bindings" not in card
    assert designs.load(tmp_path)["Live"]["root"]["children"][0]["text"] == "Live"
    for values in ({"/root/type": "image"}, {"name": {}}, {"name": "x" * 500}, {"__proto__": "bad"}):
        with pytest.raises(ValidationError):
            webhooks.render(entry, values, tmp_path)
    with pytest.raises(ValidationError):
        webhooks.create("Scene", design="Live", config_dir_override=tmp_path)


def test_rotations_validate_store_and_independent_due_state(tmp_path):
    designs.save("A", CARD, tmp_path)
    designs.save("B", CARD, tmp_path)
    first = rotations.save(None, {"designs": ["A", "B"], "interval_seconds": 15}, tmp_path)
    second = rotations.save(None, {"designs": ["B"], "interval_seconds": 30, "enabled": False}, tmp_path)
    entries, state = rotations.load(tmp_path), {}
    entries[second]["enabled"] = True  # Exercise independent due state for legacy configurations.
    assert rotations.due(entries, state, 100) == [(first, "A"), (second, "B")]
    assert rotations.due(entries, state, 114) == []
    assert rotations.due(entries, state, 115) == [(first, "B")]
    assert rotations.due(entries, state, 1000) == [(first, "A"), (second, "B")]
    assert rotations.due(entries, state, 1000) == []
    rotations.save(first, {"designs": ["A"], "interval_seconds": 15, "enabled": False}, tmp_path)
    assert rotations.due(rotations.load(tmp_path), state, 1001) == []
    assert first not in state
    with pytest.raises(ValidationError):
        rotations.save(None, {"designs": ["Missing"], "interval_seconds": 15}, tmp_path)
    rotations.delete(second, tmp_path)
    assert second not in rotations.load(tmp_path)


def test_rotations_reject_competing_automatic_producers_without_mutation(tmp_path):
    designs.save("A", CARD, tmp_path)
    active = rotations.save(None, {"designs": ["A"], "interval_seconds": 15}, tmp_path)
    disabled = rotations.save(None, {"designs": ["A"], "interval_seconds": 30, "enabled": False}, tmp_path)
    before = rotations.load(tmp_path)
    with pytest.raises(ValidationError, match="active rotation"):
        rotations.save(None, {"designs": ["A"], "interval_seconds": 30}, tmp_path)
    with pytest.raises(ValidationError, match="active rotation"):
        rotations.save(disabled, {"designs": ["A"], "interval_seconds": 30}, tmp_path)
    assert rotations.load(tmp_path) == before
    rotations.save(active, {"designs": ["A"], "interval_seconds": 15, "enabled": False}, tmp_path)
    (tmp_path / rotations.addons.FILE).write_text(json.dumps({
        "fixture": {"params": {}, "interval_seconds": 60, "enabled": True}
    }))
    before = rotations.load(tmp_path)
    with pytest.raises(ValidationError, match="active addon"):
        rotations.save(disabled, {"designs": ["A"], "interval_seconds": 30}, tmp_path)
    assert rotations.load(tmp_path) == before
    rotations.save(disabled, {"designs": ["A"], "interval_seconds": 30, "enabled": False}, tmp_path)


def test_sharing_redacts_tokens_queries_and_flags_missing_credentials(tmp_path, monkeypatch):
    source = {"kind": "homeassistant", "url": "https://example.com/data?token=url-secret&entity=sensor.temp", "path": "state", "token": "bearer-secret"}
    designs.save("Private", bound(source=source), tmp_path)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#abcdef"/></svg>'
    bundle = designs.export_bundle("Private", tmp_path, svg)
    serialized = json.dumps(bundle)
    assert "bearer-secret" not in serialized and "url-secret" not in serialized
    assert "entity=sensor.temp" in serialized
    assert bundle["required_secrets"] == ["/bindings/0/source/token", "/bindings/0/source/url"]
    imported = designs.import_bundle(bundle, tmp_path, name="Shared")
    assert imported["bindings"][0]["source"]["required_secrets"] == ["token", "url"]
    assert "token" not in imported["bindings"][0]["source"]
    monkeypatch.setattr(bindings.datafetch, "fetch_json", lambda *args, **kwargs: pytest.fail("missing secret fetched"))
    with pytest.raises(ValidationError):
        bindings.resolve(imported)
    assert designs.load(tmp_path)["Private"]["bindings"][0]["source"]["token"] == "bearer-secret"
    with pytest.raises(ValidationError, match="already exists"):
        designs.import_bundle(bundle, tmp_path)
    designs.import_bundle(bundle, tmp_path, overwrite=True)
    assert designs.history("Private", tmp_path)


@pytest.mark.parametrize("changes", [{"version": 2}, {"version": True}, {"format": "other"}, {"thumbnail": '<svg><script>alert(1)</script></svg>'}, {"thumbnail": "data:image/png;base64,bm90LXBuZw=="}, {"card": {"root": {"type": "script"}}}, {"card": {"bindings": [None]}}])
def test_import_validation_leaves_store_unchanged(tmp_path, changes):
    designs.save("A", CARD, tmp_path)
    bundle = {"format": "webos-foundry-design", "version": 1, "name": "B", "card": CARD, **changes}
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    with pytest.raises(ValidationError):
        designs.import_bundle(bundle, tmp_path)
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before


def test_png_thumbnail_strips_metadata_and_rejects_bad_crc():
    def chunk(kind, payload):
        return len(payload).to_bytes(4, "big") + kind + payload + binascii.crc32(kind + payload).to_bytes(4, "big")

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00")
    png += chunk(b"tEXt", b"Comment\x00private-token") + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff")) + chunk(b"IEND", b"")
    value = "data:image/png;base64," + base64.b64encode(png).decode()
    cleaned = base64.b64decode(designs._thumbnail(value).split(",", 1)[1])
    assert b"private-token" not in cleaned and b"IDAT" in cleaned
    broken = png[:-1] + bytes([png[-1] ^ 1])
    with pytest.raises(ValidationError):
        designs._thumbnail("data:image/png;base64," + base64.b64encode(broken).decode())
