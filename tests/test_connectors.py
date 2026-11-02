import copy
import io
import json
import urllib.error
import urllib.request

import pytest

from tests.fakes import FakeTransport
from webos_foundry import connectors, notify
from webos_foundry.connectors import football
from webos_foundry.errors import ValidationError

MATCHES = [
    {"leagueName": "1. Fußball-Bundesliga", "team1": {"teamName": "Bayern München"},
     "team2": {"teamName": "SC Freiburg"}, "matchDateTimeUTC": "2026-11-07T14:30:00Z",
     "matchResults": [
         {"resultTypeID": 2, "resultOrderID": 2, "pointsTeam1": 3, "pointsTeam2": 1},
         {"resultTypeID": 1, "resultOrderID": 1, "pointsTeam1": 1, "pointsTeam2": 0},
     ]},
    {"leagueName": "1. Fußball-Bundesliga", "team1": {"teamName": "Dortmund"},
     "team2": {"teamName": "Mainz"}, "matchDateTimeUTC": "2026-11-08T16:30:00Z",
     "matchResults": []},
]


@pytest.fixture
def api(monkeypatch):
    calls = []
    data = copy.deepcopy(MATCHES)

    def urlopen(url, timeout):
        calls.append((url, timeout))
        return io.BytesIO(json.dumps(data).encode())

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return data, calls


def test_football_poll_builds_valid_scoreboard(api):
    _, calls = api
    body = football.poll({})
    assert notify.check_overlay_request(body) == body
    assert calls == [("https://api.openligadb.de/getmatchdata/bl1", 8)]
    children = body["root"]["children"]
    assert children[0]["text"] == "1. Fußball-Bundesliga"
    assert [node["text"] for node in children[1]["children"]] == ["Bayern München", "3 : 1", "SC Freiburg"]
    assert children[2] == {"type": "divider"}
    assert children[3]["children"][1]["text"] == "08 Nov 16:30 UTC"


def test_football_caps_matches_within_widget_limits(api):
    data, _ = api
    data.extend(copy.deepcopy(MATCHES) * 10)
    body = football.poll({"league": "bl2"})
    assert notify.check_overlay_request(body) == body
    children = body["root"]["children"]
    assert sum(node["type"] == "row" for node in children) == 6
    assert children[-1]["text"] == "Showing 6 of 22 matches"


def test_football_empty_matchday_is_a_valid_card(api):
    data, _ = api
    data.clear()
    body = football.poll({})
    assert notify.check_overlay_request(body) == body
    assert body["root"]["children"][-1]["text"] == "No matches available"


@pytest.mark.parametrize("error", [urllib.error.URLError("offline"), TimeoutError("timed out")])
def test_football_network_errors_are_clean(monkeypatch, error):
    def urlopen(url, timeout):
        raise error

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    with pytest.raises(RuntimeError, match="Could not fetch OpenLigaDB football data"):
        football.poll({})


@pytest.mark.parametrize("raw", [b"not json", b"{}", b"[null]", b"[{\"leagueName\": \"League\"}]"])
def test_football_malformed_responses_are_clean(monkeypatch, raw):
    monkeypatch.setattr(urllib.request, "urlopen", lambda url, timeout: io.BytesIO(raw))
    with pytest.raises(RuntimeError, match="OpenLigaDB returned malformed football data"):
        football.poll({})


@pytest.mark.parametrize("field,value", [
    ("matchResults", [{"resultOrderID": 2, "pointsTeam1": "3", "pointsTeam2": 1}]),
    ("matchResults", [{"resultOrderID": "second", "pointsTeam1": 3, "pointsTeam2": 1}]),
    ("matchResults", {}),
    ("team1", {"teamName": "Invalid\nname"}),
])
def test_football_rejects_malformed_match_fields(api, field, value):
    data, _ = api
    data[0][field] = value
    with pytest.raises(RuntimeError, match="malformed football data"):
        football.poll({})


def test_football_rejects_bad_kickoff(api):
    data, _ = api
    data[1]["matchDateTimeUTC"] = "2026-11-08T16:30:00"
    with pytest.raises(RuntimeError, match="malformed football data"):
        football.poll({})


@pytest.mark.parametrize("params", [None, [], {"league": "../bl1"}, {"league": ""}, {"league": 1},
                                        {"league": "x" * 41}, {"league": "bl1?season=2026"}])
def test_football_rejects_invalid_parameters_before_fetch(api, params):
    with pytest.raises(ValidationError):
        football.poll(params)
    assert api[1] == []


def test_registry_and_run_show_valid_card(api):
    assert connectors.CONNECTORS["football"] is football.poll
    transport = FakeTransport({"notify-overlay": '{"returnValue": true, "overlay": "shown"}'})
    assert connectors.run("football", {"league": "bl2"}, transport) == "Overlay card shown"
    assert api[1] == [(football.API_URL + "bl2", 8)]
    assert transport.commands == ["notify-overlay"]
    sent = json.loads(transport.calls[0].data)
    assert notify.check_overlay_request(sent) == sent


def test_unknown_connector_is_validation_error():
    transport = FakeTransport()
    with pytest.raises(ValidationError, match="Unknown connector: missing"):
        connectors.run("missing", {}, transport)
    assert transport.calls == []
