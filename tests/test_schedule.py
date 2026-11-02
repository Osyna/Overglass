import json
from datetime import datetime

import pytest

from webos_foundry import schedule
from webos_foundry.errors import ValidationError


@pytest.mark.parametrize("now, expected", [
    (datetime(2026, 11, 2, 20, 0), ["monday"]),
    (datetime(2026, 11, 2, 20, 0, 59), ["monday"]),
    (datetime(2026, 11, 2, 19, 59), []),
    (datetime(2026, 11, 2, 20, 1), []),
    (datetime(2026, 11, 3, 20, 0), []),
    (datetime(2026, 11, 1, 20, 0), []),
    (datetime(2026, 11, 9, 20, 0), ["monday"]),
])
def test_due_monday_at_twenty_only(now, expected):
    entries = {"monday": {"time": "20:00", "days": ["mon"]}}
    assert schedule.due(entries, now) == expected
    # due() is pure; the server thread, not this matcher, suppresses repeat polls in one minute.
    assert schedule.due(entries, now) == expected


@pytest.mark.parametrize("weekday", range(7))
def test_due_every_day_disabled_and_day_boundaries(weekday):
    now = datetime(2026, 11, 2 + weekday, 0, 0)
    entries = {
        "every": {"time": "00:00", "days": [], "enabled": True},
        "omitted": {"time": "00:00"},
        "disabled": {"time": "00:00", "enabled": False},
        "day": {"time": "00:00", "days": [schedule.DAYS[weekday]]},
        "other": {"time": "23:59", "days": []},
    }
    assert schedule.due(entries, now) == ["every", "omitted", "day"]
    assert entries["every"]["days"] == []


def test_due_defaults_to_local_now(monkeypatch):
    class Clock:
        @staticmethod
        def now():
            return datetime(2026, 11, 8, 23, 59)

    monkeypatch.setattr(schedule, "datetime", Clock)
    assert schedule.due({"sun": {"time": "23:59", "days": ["sun"]}}) == ["sun"]


def test_check_entry_defaults_and_unknown_scene():
    assert schedule.check_entry({"scene": "not saved yet", "time": "20:00"}) == {
        "scene": "not saved yet", "time": "20:00", "days": [], "enabled": True,
    }


@pytest.mark.parametrize("body", [
    None, [], {}, {"scene": "", "time": "20:00"}, {"scene": "  ", "time": "20:00"},
    {"scene": 2, "time": "20:00"},
    *({"scene": "x", "time": clock} for clock in (None, 2000, "2:00", "24:00", "20:60", "20:00\n", "-1:00")),
    *({"scene": "x", "time": "20:00", "days": days} for days in (None, "mon", ["MON"], ["monday"], [1], [[]])),
    *({"scene": "x", "time": "20:00", "enabled": value} for value in (0, 1, "true", None)),
    {"scene": "x", "time": "20:00", "extra": True},
])
def test_check_entry_rejects_invalid_inputs(body):
    with pytest.raises(ValidationError):
        schedule.check_entry(body)


def test_storage_round_trip(tmp_path):
    directory = tmp_path / "config"
    assert schedule.load(directory) == {}
    first = schedule.save(None, {"scene": "future-scene", "time": "20:00"}, directory)
    second = schedule.save(None, {"scene": "other", "time": "00:00", "days": ["sun"], "enabled": False}, directory)
    assert first and first != second
    path = directory / "schedule.json"
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text()) == schedule.load(directory)
    assert schedule.load(directory)[first] == {
        "id": first, "scene": "future-scene", "time": "20:00", "days": [], "enabled": True,
    }
    assert schedule.save(first, {"scene": "updated", "time": "23:59", "days": ["mon", "fri"]}, directory) == first
    assert schedule.load(directory)[first]["scene"] == "updated"
    assert schedule.load(directory)[second]["enabled"] is False
    schedule.delete(first, directory)
    assert list(schedule.load(directory)) == [second]
    schedule.delete(second, directory)
    assert schedule.load(directory) == {}
    for operation in (lambda: schedule.delete(first, directory),
                      lambda: schedule.save(first, {"scene": "x", "time": "20:00"}, directory)):
        with pytest.raises(ValidationError, match="No such schedule entry"):
            operation()
    assert schedule.load(directory) == {}


@pytest.mark.parametrize("document", ["not json", "[]", '{"x": {}}',
    '{"x": {"id":"x", "scene":"s", "time":"25:00"}}'])
def test_storage_rejects_corruption_without_overwriting(tmp_path, document):
    path = tmp_path / "schedule.json"
    path.write_text(document)
    with pytest.raises(ValidationError):
        schedule.save(None, {"scene": "x", "time": "20:00"}, tmp_path)
    assert path.read_text() == document


def test_failed_atomic_replace_preserves_existing_entries(tmp_path, monkeypatch):
    schedule.save(None, {"scene": "existing", "time": "20:00"}, tmp_path)
    before = (tmp_path / "schedule.json").read_bytes()

    def fail(*args):
        raise OSError("replace failed")

    monkeypatch.setattr(schedule.os, "replace", fail)
    with pytest.raises(OSError, match="replace failed"):
        schedule.save(None, {"scene": "new", "time": "21:00"}, tmp_path)
    assert (tmp_path / "schedule.json").read_bytes() == before
    assert not list(tmp_path.glob(".schedule-*"))
