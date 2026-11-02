import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from webos_foundry import connectors, datafetch, notify
from webos_foundry.connectors import calendar, football, homeassistant, json_api, rss, weather
from webos_foundry.errors import ValidationError


@pytest.fixture
def source():
    response = {"body": {"temperature": 21.5}}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.path, self.headers.get("Authorization")))
            self.send_response(200)
            self.end_headers()
            body = response["body"]
            self.wfile.write(body.encode() if isinstance(body, str) else json.dumps(body).encode())

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:%d" % server.server_port, response, requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def _texts(card):
    result = []

    def walk(node):
        if "text" in node:
            result.append(node["text"])
        if node.get("type") == "list":
            result.extend(node["items"])
        for child in node.get("children", []):
            walk(child)
    walk(card["root"])
    return result


def test_registry_metadata_has_real_typed_forms():
    assert set(connectors.CONNECTORS) == {"football", "json", "homeassistant", "weather", "calendar", "rss"}
    for name, meta in connectors.META.items():
        assert meta["name"] and meta["description"]
        assert len({field["key"] for field in meta["params_schema"]}) == len(meta["params_schema"])
        assert all(field["type"] in ("string", "select", "number", "boolean", "secret") for field in meta["params_schema"])
    assert next(field for field in homeassistant.META["params_schema"] if field["key"] == "token")["type"] == "secret"
    assert next(field for field in homeassistant.META["params_schema"] if field["key"] == "allow_private")["default"] is False


def test_json_scalar_and_bearer_token(source):
    url, response, requests = source
    response["body"] = {"current": {"temperature": 21.5}}
    card = json_api.poll({"url": url, "path": "/current/temperature", "label": "Room", "token": "fixture-secret", "allow_private": True})
    assert notify.check_overlay_request(card) == card
    assert _texts(card) == ["Room", "21.5"]
    assert requests == [("/", "Bearer fixture-secret")]
    with pytest.raises(ValidationError, match="scalar"):
        json_api.poll({"url": url, "path": "current", "allow_private": True})


@pytest.mark.parametrize("value,rendered", [(None, "null"), (False, "false"), (0, "0"), ("ready", "ready")])
def test_json_preserves_actual_scalar_values(monkeypatch, value, rendered):
    monkeypatch.setattr(json_api, "fetch_json", lambda *_, **__: value)
    assert rendered in _texts(json_api.poll({"url": "https://example.com/value"}))


def test_homeassistant_real_state_and_auth(source):
    url, response, requests = source
    response["body"] = {"entity_id": "sensor.room", "state": "20.4", "attributes": {"friendly_name": "Living room", "unit_of_measurement": "°C"}}
    card = homeassistant.poll({"url": url + "/ha", "token": "fixture-secret", "entity_id": "sensor.room", "allow_private": True})
    assert _texts(card) == ["Living room", "20.4 °C", "sensor.room"]
    assert requests == [("/ha/api/states/sensor.room", "Bearer fixture-secret")]
    response["body"]["state"] = "unavailable"
    assert "unavailable °C" in _texts(homeassistant.poll({"url": url, "token": "fixture-secret", "entity_id": "sensor.room", "allow_private": True}))


@pytest.mark.parametrize("params", [{"entity_id": "../state"}, {"token": ""}, {"allow_private": "true"}])
def test_homeassistant_rejects_bad_parameters_without_request(source, params):
    url, _, requests = source
    with pytest.raises(ValidationError):
        homeassistant.poll({"url": url, "token": "fixture-secret", "entity_id": "sensor.room", **params})
    assert requests == []


def test_weather_real_fixture_current_values_and_url(source, monkeypatch):
    url, response, _ = source
    response["body"] = {"current": {"temperature_2m": 12.3, "relative_humidity_2m": 72, "wind_speed_10m": 9.1, "time": "2026-11-02T12:30"},
                        "current_units": {"temperature_2m": "°C", "relative_humidity_2m": "%", "wind_speed_10m": "km/h"}}
    calls = []

    def fetch(endpoint):
        calls.append(endpoint)
        return datafetch.fetch_json(url, allow_private=True)

    monkeypatch.setattr(weather, "fetch_json", fetch)
    card = weather.poll({"latitude": 52.52, "longitude": 13.405, "label": "Berlin"})
    assert calls[0].startswith("https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.405&")
    assert card["root"]["children"][1]["items"] == [{"label": "Temperature", "value": "12.3 °C"}, {"label": "Humidity", "value": "72 %"}, {"label": "Wind", "value": "9.1 km/h"}]
    assert notify.check_overlay_request(card) == card


@pytest.mark.parametrize("params", [{"latitude": 91, "longitude": 0}, {"latitude": 0, "longitude": -181}, {"latitude": True, "longitude": 0}, {"latitude": "nan", "longitude": 0}])
def test_weather_coordinates_validated_before_network(monkeypatch, params):
    monkeypatch.setattr(weather, "fetch_json", lambda *_: pytest.fail("must not fetch"))
    with pytest.raises(ValidationError):
        weather.poll(params)


@pytest.mark.parametrize("feed", ['<rss><channel><title>News</title><item><title>A &amp; B</title></item><item><title>Second</title></item></channel></rss>',
                                  '<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title><entry><title>A &amp; B</title></entry><entry><title>Second</title></entry></feed>'])
def test_rss_and_atom_are_bounded_plain_headlines(source, feed):
    url, response, _ = source
    response["body"] = feed
    card = rss.poll({"url": url, "allow_private": True, "limit": 1})
    assert _texts(card) == ["News", "A & B"]
    assert notify.check_overlay_request(card) == card


@pytest.mark.parametrize("feed", ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>',
                                  '<rss>' + '<x>' * 21 + '</x>' * 21 + '</rss>', '<rss>' + '<x/>' * 4001 + '</rss>', '<html/>', '<rss><broken>'])
def test_rss_xml_trust_boundary(source, feed):
    url, response, _ = source
    response["body"] = feed
    with pytest.raises(RuntimeError):
        rss.poll({"url": url, "allow_private": True})


def test_calendar_real_events_unfolding_timezone_and_cancelled(source):
    url, response, _ = source
    response["body"] = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "DTSTART;TZID=Europe/Berlin:20991102T180000", "SUMMARY:Real meeting\\, with a", "  folded title", "LOCATION:Office", "END:VEVENT", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20991103", "SUMMARY:Day off", "END:VEVENT", "BEGIN:VEVENT", "DTSTART:20991104T120000Z", "STATUS:CANCELLED", "SUMMARY:Cancelled", "END:VEVENT", "END:VCALENDAR"])
    card = calendar.poll({"url": url, "allow_private": True})
    rendered = _texts(card)
    assert any("18:00 Europe/Berlin — Real meeting, with a folded title · Office" in value for value in rendered)
    assert any("(all day) — Day off" in value for value in rendered)
    assert not any("Cancelled" in value for value in rendered)
    assert notify.check_overlay_request(card) == card


def test_calendar_recurring_series_is_not_fabricated_as_next_occurrence():
    lines = calendar._events("BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20200101T120000Z\nRRULE:FREQ=WEEKLY\nSUMMARY:Actual recurring series\nEND:VEVENT\nEND:VCALENDAR")
    assert lines == ["Series starts 01 Jan 12:00 UTC — Actual recurring series"]


@pytest.mark.parametrize("source", ["not a calendar", "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:invalid\nEND:VEVENT\nEND:VCALENDAR", "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=No/SuchZone:20991102T180000\nEND:VEVENT\nEND:VCALENDAR", "BEGIN:VCALENDAR\n" + "BEGIN:X\n" * 8, "BEGIN:VCALENDAR\n" + "X:y\n" * 20001])
def test_calendar_malformed_and_parser_limits(source):
    with pytest.raises(RuntimeError):
        calendar._events(source)


def test_football_table_genuine_endpoint_and_fields(source, monkeypatch):
    url, response, _ = source
    response["body"] = [{"teamName": "Actual Club", "points": 18, "matches": 8, "won": 5, "draw": 3, "lost": 0, "goals": 20, "opponentGoals": 8}]
    calls = []

    def fetch(endpoint):
        calls.append(endpoint)
        return datafetch.fetch_json(url, allow_private=True)

    monkeypatch.setattr(football, "fetch_json", fetch)
    card = football.poll({"view": "table", "league": "bl1", "season": 2026})
    assert calls == ["https://api.openligadb.de/getbltable/bl1/2026"]
    assert "1. Actual Club · 18 pts · P8 W5 D3 L0 · 20:8" in _texts(card)
    assert notify.check_overlay_request(card) == card


def test_football_season_matches_and_missing_lineup_are_explicit(monkeypatch):
    calls = []
    monkeypatch.setattr(football, "fetch_json", lambda url: calls.append(url) or [])
    football.poll({"season": 2025})
    assert calls == ["https://api.openligadb.de/getmatchdata/bl1/2025"]
    with pytest.raises(ValidationError, match="genuine"):
        football.poll({"view": "lineups"})
    with pytest.raises(ValidationError, match="season"):
        football.poll({"view": "table"})
    assert len(calls) == 1


def test_football_lineups_use_real_supplied_roster_and_token(source):
    url, response, requests = source
    response["body"] = {"match": "Home vs Away", "home": {"name": "Home", "formation": "4-3-3", "players": [{"name": "Actual Player", "number": 9, "position": "Forward"}]}, "away": {"name": "Away", "players": [{"name": "Real Player"}]}}
    card = football.poll({"view": "lineups", "lineup_url": url, "lineup_token": "fixture-secret", "allow_private": True})
    assert "9 · Actual Player · Forward" in _texts(card)
    assert "Real Player" in _texts(card)
    assert requests == [("/", "Bearer fixture-secret")]
    assert notify.check_overlay_request(card) == card
    response["body"]["away"]["players"] = []
    with pytest.raises(RuntimeError, match="malformed per-match"):
        football.poll({"view": "lineups", "lineup_url": url, "allow_private": True})


@pytest.mark.parametrize("state,expected", [("armed_away", "online"), ("disarmed", "degraded"), ("on", "degraded"), ("unavailable", "degraded")])
def test_ha_status_explicit_literal_mapping(source, state, expected):
    url, response, _ = source
    response["body"] = {"state": state, "attributes": {"friendly_name": "Alarm"}}
    card = homeassistant.poll({"url": url, "token": "fixture-secret", "entity_id": "alarm_control_panel.home",
                               "allow_private": True, "display": "status", "status_value": "armed_away",
                               "status_match": "online", "status_other": "degraded"})
    assert notify.check_overlay_request(card) == card
    assert card["root"]["children"][1] == {"type": "status", "label": "Alarm", "state": expected, "detail": state}


@pytest.mark.parametrize("state,fraction,measurement", [("25.5", 0.255, "25.5 °C"), ("-5", 0, "-5 °C"), ("125", 1, "125 °C"), ("1e1", 0.1, "10 °C")])
def test_ha_stat_numeric_state_and_configured_scale(source, state, fraction, measurement):
    url, response, _ = source
    response["body"] = {"state": state, "attributes": {"friendly_name": "Room", "unit_of_measurement": "°C"}}
    card = homeassistant.poll({"url": url, "token": "fixture-secret", "entity_id": "sensor.room", "allow_private": True,
                               "display": "stat", "stat_min": 0, "stat_max": 100})
    assert notify.check_overlay_request(card) == card
    widget = card["root"]["children"][1]
    assert widget["type"] == "stat" and widget["fraction"] == fraction and widget["left"] == measurement


@pytest.mark.parametrize("state", ["unavailable", "unknown", "on", "NaN", "Infinity", "1e9999", "25 °C", "true", "01"])
def test_ha_stat_never_fabricates_numeric_state(source, state):
    url, response, _ = source
    response["body"] = {"state": state, "attributes": {}}
    with pytest.raises(RuntimeError, match="finite numeric entity state"):
        homeassistant.poll({"url": url, "token": "fixture-secret", "entity_id": "sensor.room", "allow_private": True, "display": "stat"})
