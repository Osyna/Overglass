import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from webos_foundry import datafetch
from webos_foundry.errors import ValidationError


@pytest.fixture
def endpoint():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append((self.path, dict(self.headers)))
            if self.path.startswith("/redirect"):
                self.send_response(302)
                self.send_header("Location", self.server.destination)
                self.end_headers()
                return
            if self.path == "/large":
                body = b"x" * (datafetch.MAX_BYTES + 1)
            elif self.path == "/invalid":
                body = b'{"secret": NaN}'
            elif self.path == "/badjson":
                body = b'not JSON: TOP-SECRET'
            elif self.path == "/error?token=TOP-SECRET":
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b"TOP-SECRET")
                return
            else:
                body = b'{"value":42}'
            if self.path == "/slow":
                time.sleep(0.5)
            self.send_response(200)
            if self.path == "/compressed":
                self.send_header("Content-Encoding", "gzip")
            if self.path == "/length":
                self.send_header("Content-Length", str(datafetch.MAX_BYTES + 1))
            elif self.path == "/sized":
                self.send_header("Content-Length", str(len(body)))
            elif self.path == "/truncated":
                self.send_header("Content-Length", str(len(body) + 1))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = "http://127.0.0.1:%d" % server.server_port
    try:
        yield url, server, calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_private_is_explicit_and_local_http_fixture_is_real(endpoint):
    url, _, calls = endpoint
    with pytest.raises(ValidationError, match="not public"):
        datafetch.fetch_json(url)
    assert calls == []
    assert datafetch.fetch_json(url, allow_private=True) == {"value": 42}
    assert len(calls) == 1
    with pytest.raises(ValidationError, match="boolean"):
        datafetch.fetch_json(url, allow_private="true")


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/x", "http://user:SECRET@example.com", "http://example.com:0", "http://example.com/\nsecret", "http://[::1%25lo]/"])
def test_invalid_urls_never_reach_dns(monkeypatch, url):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_: pytest.fail("DNS must not run"))
    with pytest.raises(ValidationError) as error:
        datafetch.fetch_text(url)
    assert "SECRET" not in str(error.value)


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "::ffff:127.0.0.1"])
def test_private_dns_and_mixed_answers_are_rejected(monkeypatch, ip):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80)),
        (family, socket.SOCK_STREAM, 6, "", (ip, 80))])
    with pytest.raises(ValidationError, match="not public"):
        datafetch.fetch_json("http://public.example/")


def test_connection_uses_checked_ip_without_second_lookup(monkeypatch):
    connected = []

    class Socket:
        def settimeout(self, value):
            assert 0 < value <= datafetch.TIMEOUT

        def connect(self, address):
            connected.append(address)

        def close(self):
            pass

    monkeypatch.setattr(socket, "socket", lambda *_: Socket())
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_: pytest.fail("must not resolve again"))
    parts, host, port = datafetch._url("http://public.example/data")
    connection = datafetch._connection(parts, host, port,
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80)), time.monotonic() + 8)
    try:
        connection.connect()
        assert connected == [("93.184.216.34", 80)]
        assert connection.host == "public.example"
    finally:
        connection._deadline_timer.cancel()
        connection.close()


def test_redirect_revalidates_and_strips_cross_origin_credentials(endpoint, monkeypatch):
    url, server, calls = endpoint
    resolve = socket.getaddrinfo
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port, *_: resolve(host, port, socket.AF_INET, socket.SOCK_STREAM))
    server.destination = url.replace("127.0.0.1", "localhost") + "/ok"
    assert datafetch.fetch_json(url + "/redirect", headers={"Authorization": "Bearer SECRET", "X-API-Key": "SECRET"}, allow_private=True) == {"value": 42}
    assert calls[0][1]["Authorization"] == "Bearer SECRET"
    assert "Authorization" not in calls[1][1]
    assert "X-API-Key" not in calls[1][1]


def test_same_origin_redirect_keeps_authorization(endpoint):
    url, server, calls = endpoint
    server.destination = "/ok"
    datafetch.fetch_json(url + "/redirect", headers={"Authorization": "Bearer SECRET"}, allow_private=True)
    assert calls[1][1]["Authorization"] == "Bearer SECRET"


def test_redirect_to_non_http_is_not_allowed_even_with_private_opt_in(endpoint):
    url, server, _ = endpoint
    server.destination = "file:///etc/passwd"
    with pytest.raises(ValidationError):
        datafetch.fetch_text(url + "/redirect", allow_private=True)


def test_public_redirect_to_private_is_rejected(monkeypatch, endpoint):
    url, server, calls = endpoint
    server.destination = url + "/ok"
    original_addresses = datafetch._addresses
    original_connection = datafetch._connection

    def addresses(host, port, private, deadline):
        if host == "public.example":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]
        return original_addresses(host, port, private, deadline)

    def connection(parts, host, port, address, deadline):
        return original_connection(parts, host, port,
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", server.server_port)), deadline)

    monkeypatch.setattr(datafetch, "_addresses", addresses)
    monkeypatch.setattr(datafetch, "_connection", connection)
    with pytest.raises(ValidationError, match="not public"):
        datafetch.fetch_text("http://public.example/redirect")
    assert len(calls) == 1


@pytest.mark.parametrize("path,message", [("/large", "size limit"), ("/length", "size limit"), ("/truncated", "declared length"), ("/compressed", "Compressed"), ("/invalid", "malformed JSON"), ("/badjson", "malformed JSON"), ("/error?token=TOP-SECRET", "HTTP 401")])
def test_response_limits_and_secret_safe_errors(endpoint, path, message):
    with pytest.raises(RuntimeError, match=message) as error:
        datafetch.fetch_json(endpoint[0] + path, headers={"Authorization": "Bearer TOP-SECRET"}, allow_private=True)
    assert "TOP-SECRET" not in str(error.value)
    assert endpoint[0] not in str(error.value)


def test_redirect_loop_is_bounded(endpoint):
    url, server, calls = endpoint
    server.destination = "/redirect"
    with pytest.raises(RuntimeError, match="redirect limit"):
        datafetch.fetch_text(url + "/redirect", allow_private=True)
    assert len(calls) == datafetch.MAX_REDIRECTS + 1


def test_dns_timeout_is_bounded(monkeypatch):
    gate = threading.Event()
    monkeypatch.setattr(datafetch, "TIMEOUT", 0.05)
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_: gate.wait(1))
    try:
        with pytest.raises(RuntimeError, match="timed out"):
            datafetch.fetch_json("http://example.com")
    finally:
        gate.set()


def test_content_length_response_finishes_without_reading_closed_socket(endpoint):
    assert datafetch.fetch_json(endpoint[0] + "/sized", allow_private=True) == {"value": 42}


def test_network_deadline_is_enforced(endpoint, monkeypatch):
    monkeypatch.setattr(datafetch, "TIMEOUT", 0.15)
    with pytest.raises(RuntimeError):
        datafetch.fetch_json(endpoint[0] + "/slow", allow_private=True)


@pytest.mark.parametrize("path,expected", [("value.a.0", 42), ("/value/a/0", 42), ("/a~1b/~0", False), ("null", None)])
def test_scalar_paths(path, expected):
    assert datafetch.scalar_at({"value": {"a": [42]}, "a/b": {"~": False}, "null": None}, path) == expected


@pytest.mark.parametrize("path", ["value", "__proto__.x", "/constructor", "/bad~2path", "value.a.-1", "missing"])
def test_scalar_paths_reject_objects_prototypes_and_missing(path):
    with pytest.raises(ValidationError):
        datafetch.scalar_at({"value": {"a": [42]}, "__proto__": {"x": 1}, "constructor": 1}, path)
