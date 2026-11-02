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
    {"leagueName": "1. Fußball-Bundesliga", "group": {"groupName": "8. Spieltag"},
     "team1": {"teamId": 198, "teamName": "Bayern München", "shortName": "Bayern",
               "teamIconUrl": "https://example.com/bayern.svg"},
     "team2": {"teamId": 81, "teamName": "SC Freiburg", "shortName": "Freiburg", "teamIconUrl": None},
     "matchDateTimeUTC": "2026-11-07T14:30:00Z", "matchIsFinished": True,
     "matchResults": [
         {"resultTypeID": 2, "resultOrderID": 2, "pointsTeam1": 3, "pointsTeam2": 1},
         {"resultTypeID": 1, "resultOrderID": 1, "pointsTeam1": 1, "pointsTeam2": 0},
     ],
     "goals": [
         {"matchMinute": 12, "goalGetterName": "H. Kane", "scoringTeamId": 198, "isPenalty": False, "isOwnGoal": False},
         {"matchMinute": 55, "goalGetterName": "V. Ginter", "scoringTeamId": 81, "isPenalty": False, "isOwnGoal": True},
         {"matchMinute": 78, "goalGetterName": "L. Sané", "scoringTeamId": 198, "isPenalty": True, "isOwnGoal": False},
     ]},
    {"leagueName": "1. Fußball-Bundesliga", "group": {"groupName": "8. Spieltag"},
     "team1": {"teamId": 16, "teamName": "Dortmund", "shortName": "Dortmund", "teamIconUrl": None},
     "team2": {"teamId": 79, "teamName": "Mainz", "shortName": "Mainz", "teamIconUrl": None},
     "matchDateTimeUTC": "2026-11-08T16:30:00Z", "matchIsFinished": False, "matchResults": [], "goals": []},
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


def _row_texts(row):
    return [n["text"] for n in row["children"] if n["type"] == "text"]


def test_football_poll_builds_a_rich_scoreboard(api):
    _, calls = api
    body = football.poll({})
    assert notify.check_overlay_request(body) == body
    assert calls == [("https://api.openligadb.de/getmatchdata/bl1", 8)]
    children = body["root"]["children"]
    header = children[0]["children"]
    assert header[0]["text"] == "1. Fußball-Bundesliga" and header[1]["text"] == "8. Spieltag"
    assert children[1] == {"type": "divider"}
    match_row = children[2]
    assert _row_texts(match_row["children"][0]) == ["Bayern München"]
    assert match_row["children"][0]["children"][0]["type"] == "image"  # crest first (Bayern has a teamIconUrl)
    assert match_row["children"][1] == {"type": "badge", "text": "3 - 1", "tone": "info"}  # finished: no live inference
    assert _row_texts(match_row["children"][2]) == ["SC Freiburg"]
    assert match_row["children"][2]["children"][-1]["type"] == "text"  # no crest for Freiburg: text only, no image
    goals = children[3]
    assert goals == {"type": "list", "style": "plain", "items": [
        "12' H. Kane — Bayern",
        "55' V. Ginter (OG) — Freiburg",  # attributed to scoringTeamId as the API reports it, no own-goal flip
        "78' L. Sané (pen.) — Bayern",
    ]}
    assert children[4] == {"type": "divider"}
    second_row = children[5]
    assert second_row["children"][1]["text"] == "08 Nov 16:30 UTC"  # not started: kickoff time, no badge tone
    assert "tone" not in second_row["children"][1]


def test_football_infers_live_from_an_unfinished_started_match(api, monkeypatch):
    data, _ = api
    data[1]["matchDateTimeUTC"] = "2000-01-01T00:00:00Z"  # long past kickoff
    data[1]["matchResults"] = [{"resultTypeID": 1, "resultOrderID": 1, "pointsTeam1": 1, "pointsTeam2": 0}]
    body = football.poll({})
    second_row = body["root"]["children"][5]
    assert second_row["children"][1] == {"type": "badge", "text": "1 - 0", "tone": "success"}


def test_football_caps_matches_within_widget_limits(api):
    data, _ = api
    base = data[1]
    data.extend(copy.deepcopy(base) for _ in range(20))
    body = football.poll({})
    children = body["root"]["children"]
    assert children[-1]["text"] == "Showing 6 of 22 matches"


def test_football_empty_matchday_is_a_valid_card(api):
    data, _ = api
    data.clear()
    body = football.poll({})
    assert body["root"]["children"][-1]["text"] == "No matches available"


@pytest.mark.parametrize("error", [urllib.error.URLError("offline"), TimeoutError("timed out")])
def test_football_network_errors_are_clean(monkeypatch, error):
    def urlopen(url, timeout):
        raise error

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    with pytest.raises(RuntimeError, match="Could not fetch"):
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
    ("team1", {"teamId": 1, "teamName": "Invalid\nname"}),
    ("matchIsFinished", "yes"),
    ("goals", [{"matchMinute": "soon", "goalGetterName": "x", "scoringTeamId": 198}]),
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


def test_football_rejects_a_bad_crest_url(api):
    data, _ = api
    data[0]["team1"]["teamIconUrl"] = "javascript:alert(1)"
    body = football.poll({})  # an invalid crest is dropped, not a hard failure: the scoreboard still renders
    match_row = body["root"]["children"][2]
    assert match_row["children"][0]["children"][0]["type"] == "text"  # no image widget for the bad URL


@pytest.mark.parametrize("params", [None, [], {"league": "../bl1"}, {"league": ""}, {"league": 1},
                                        {"league": "x" * 41}, {"league": "bl1?season=2026"}])
def test_football_rejects_invalid_parameters_before_fetch(api, params):
    with pytest.raises(ValidationError):
        football.poll(params)
    assert api[1] == []


def test_meta_describes_the_addon():
    assert football.META["name"] and football.META["category"] == "sports"
    leagues = {c["value"] for c in football.META["params_schema"][0]["choices"]}
    assert "bl1" in leagues


def test_registry_and_run_show_valid_card(api):
    assert connectors.CONNECTORS["football"] is football.poll
    assert connectors.META["football"] is football.META
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
