import socket
import time

import pytest

from webos_foundry import datafetch, notify
from webos_foundry.connectors import calendar, football, homeassistant, rss, weather
from webos_foundry.errors import ValidationError


def test_tls_wrap_verifies_original_hostname_after_ip_pinning(monkeypatch):
    calls = []

    class Socket:
        def settimeout(self, timeout):
            assert 0 < timeout <= 8

        def connect(self, address):
            calls.append(("connect", address))

        def do_handshake(self):
            calls.append(("handshake",))

        def close(self):
            pass

    class Context:
        def wrap_socket(self, sock, server_hostname, do_handshake_on_connect):
            assert do_handshake_on_connect is False
            calls.append(("hostname", server_hostname))
            return sock

    monkeypatch.setattr(socket, "socket", lambda *_: Socket())
    monkeypatch.setattr(datafetch.ssl, "create_default_context", lambda: Context())
    parts, host, port = datafetch._url("https://public.example/")
    connection = datafetch._connection(parts, host, port,
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)), time.monotonic() + 8)
    try:
        connection.connect()
        assert calls == [("connect", ("93.184.216.34", 443)), ("hostname", "public.example"), ("handshake",)]
    finally:
        connection._deadline_timer.cancel()
        connection.close()


@pytest.mark.parametrize("ip", ["64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2001::1"])
def test_transition_addresses_cannot_bypass_public_check(monkeypatch, ip):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_: [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", (ip, 80, 0, 0))])
    with pytest.raises(ValidationError, match="not public"):
        datafetch.fetch_text("http://public.example/")


@pytest.mark.parametrize("headers", [{"Host": "attacker"}, {"Authorization": "Bearer secret\r\nX: y"}, {"Proxy-Authorization": "secret"}, {"Accept-Encoding": "gzip"}, {"X": "☃"}])
def test_header_boundary_prevents_request_injection(headers, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_: pytest.fail("must not resolve"))
    with pytest.raises(ValidationError):
        datafetch.fetch_text("https://example.com", headers=headers)


@pytest.mark.parametrize("data", [{}, {"current": {}}, {"current": {"temperature_2m": float("nan")}, "current_units": {"temperature_2m": "°C"}}])
def test_weather_rejects_missing_or_nonfinite_real_data(monkeypatch, data):
    monkeypatch.setattr(weather, "fetch_json", lambda *_: data)
    with pytest.raises(RuntimeError, match="malformed current conditions"):
        weather.poll({"latitude": 0, "longitude": 0})


@pytest.mark.parametrize("data", [{}, {"state": 42}, {"state": "on", "attributes": []}])
def test_ha_rejects_malformed_provider_state(monkeypatch, data):
    monkeypatch.setattr(homeassistant, "fetch_json", lambda *_, **__: data)
    with pytest.raises(RuntimeError, match="malformed entity state"):
        homeassistant.poll({"url": "https://example.com", "token": "secret", "entity_id": "sensor.room"})


def test_calendar_event_count_is_bounded():
    event = "BEGIN:VEVENT\nDTSTART:20991102T120000Z\nSUMMARY:Event\nEND:VEVENT\n"
    with pytest.raises(RuntimeError, match="malformed or unsupported"):
        calendar._events("BEGIN:VCALENDAR\n" + event * 1001 + "END:VCALENDAR")


def test_empty_calendar_and_feed_are_honest_valid_cards(monkeypatch):
    monkeypatch.setattr(calendar, "fetch_text", lambda *_, **__: "BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR")
    monkeypatch.setattr(rss, "fetch_text", lambda *_, **__: "<rss><channel><title>Empty feed</title></channel></rss>")
    for module, message in ((calendar, "No upcoming events"), (rss, "No headlines available")):
        card = module.poll({"url": "https://example.com"})
        assert notify.check_overlay_request(card) == card
        assert card["root"]["children"][1]["text"] == message


@pytest.mark.parametrize("data", [{}, [None], [{"teamName": "Club", "points": "18"}]])
def test_table_rejects_unusable_source_data(monkeypatch, data):
    monkeypatch.setattr(football, "fetch_json", lambda *_: data)
    with pytest.raises(RuntimeError, match="malformed league table"):
        football.poll({"view": "table", "season": 2025})


def test_table_and_lineup_display_bounds_preserve_widget_limits(monkeypatch):
    team = {"teamName": "Actual Club", "points": 18, "matches": 8, "won": 5, "draw": 3, "lost": 0, "goals": 20, "opponentGoals": 8}
    monkeypatch.setattr(football, "fetch_json", lambda *_: [team] * 25)
    card = football.poll({"view": "table", "season": 2025})
    assert notify.check_overlay_request(card) == card
    assert any(child.get("text") == "Showing 20 of 25 teams" for child in card["root"]["children"])
    roster = {"name": "Real Club", "players": [{"name": "Real Player", "number": number} for number in range(30)]}
    monkeypatch.setattr(football, "fetch_json", lambda *_, **__: {"match": "Actual Match", "home": roster, "away": roster})
    card = football.poll({"view": "lineups", "lineup_url": "https://example.com/match"})
    assert notify.check_overlay_request(card) == card
    roster["players"].append({"name": "Extra Player"})
    with pytest.raises(RuntimeError, match="malformed per-match"):
        football.poll({"view": "lineups", "lineup_url": "https://example.com/match"})


def test_ha_invalid_url_errors_do_not_echo_credentials():
    with pytest.raises(ValidationError) as error:
        homeassistant.poll({"url": "http://[TOP-SECRET]/", "token": "TOKEN-SECRET", "entity_id": "sensor.room"})
    assert "TOP-SECRET" not in str(error.value)
    assert "TOKEN-SECRET" not in str(error.value)


@pytest.mark.parametrize("settings", [{"display": "invalid"}, {"display": "status"}, {"display": "status", "status_value": "on", "status_match": "bad"},
                                      {"display": "status", "status_value": "on", "status_other": "bad"},
                                      {"display": "stat", "stat_min": 100, "stat_max": 100},
                                      {"display": "stat", "stat_min": 100, "stat_max": 0},
                                      {"display": "stat", "stat_min": float("nan")},
                                      {"display": "stat", "stat_max": float("inf")},
                                      {"display": "stat", "stat_min": -1e308, "stat_max": 1e308}])
def test_ha_presentation_settings_are_validated_before_fetch(monkeypatch, settings):
    monkeypatch.setattr(homeassistant, "fetch_json", lambda *_, **__: pytest.fail("must not fetch"))
    with pytest.raises(ValidationError):
        homeassistant.poll({"url": "https://example.com", "token": "secret", "entity_id": "sensor.room", **settings})


def test_ha_stat_metadata_exposes_numeric_scale_and_explicit_status_mapping():
    fields = {field["key"]: field for field in homeassistant.META["params_schema"]}
    assert {choice["value"] for choice in fields["display"]["choices"]} == {"text", "status", "stat"}
    assert fields["display"]["default"] == "text"
    assert fields["stat_min"]["type"] == fields["stat_max"]["type"] == "number"
    assert "default" not in fields["status_value"]
    assert {choice["value"] for choice in fields["status_match"]["choices"]} == set(notify.STATES)
