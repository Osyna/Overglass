import base64
import json

import pytest

from tests.fakes import FakeTransport
from webos_foundry import apps, dispatcher
from webos_foundry.errors import TransportError, ValidationError

SHA = "0123456789abcdef" * 4
URL = "https://example.com/app.ipk"
FINISHED = b'{"returnValue":true,"statusText":"Finished"}\n'


def payload(call):
    return json.loads(base64.b64decode(call.command.split(" ", 1)[1]))


def test_list_apps_returns_the_tv_array():
    items = [{"id": "com.example.game", "title": "Game", "icon": "/i.png", "version": "1", "removable": True}]
    fake = FakeTransport({"app-list": json.dumps(items)})
    assert apps.list_apps(fake) == items and fake.commands == ["app-list"]


@pytest.mark.parametrize("reply", [b"", b"nope", b'{"apps": []}', b'[1]', b'[{"title": "no id"}]', b'[{"id": 5}]'])
def test_list_apps_rejects_malformed_replies(reply):
    with pytest.raises(RuntimeError, match="malformed app list"):
        apps.list_apps(FakeTransport({"app-list": reply}))


def test_install_app_sends_compact_json_with_hash():
    fake = FakeTransport({"app-install": FINISHED})
    assert apps.install_app(fake, URL, SHA) == "App installed"
    (call,) = fake.calls
    assert dispatcher.verb_of(call.command) == "app-install" and call.timeout >= 90
    assert base64.b64decode(call.command.split(" ")[1]) == ('{"url":"%s","sha256":"%s"}' % (URL, SHA)).encode()


def test_install_app_without_hash_omits_the_key():
    fake = FakeTransport({"app-install": FINISHED})
    apps.install_app(fake, URL)
    assert payload(fake.calls[0]) == {"url": URL}


@pytest.mark.parametrize("url", [
    "ftp://example.com/a.ipk", "file:///etc/passwd", "javascript:alert(1)", "example.com/a.ipk", "http://", "",
    "http://example.com/a b", "http://example.com/a\nb", 'http://example.com/a"b', "http://example.com/a`id`",
    "http://example.com/" + "a" * 482,  # 501 characters
    None, 5, ["http://example.com"], b"http://example.com",
])
def test_install_app_rejects_bad_urls_before_sending(url):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        apps.install_app(fake, url, SHA)
    assert fake.calls == []


def test_install_app_url_length_boundary():
    fake = FakeTransport({"app-install": FINISHED})
    apps.install_app(fake, "http://example.com/" + "a" * 481, SHA)  # exactly 500 characters
    assert len(payload(fake.calls[0])["url"]) == 500


@pytest.mark.parametrize("sha", ["", "0" * 63, "0" * 65, "A" * 64, "g" * 64, "sha256:" + SHA, SHA + "\n", 5, b"0" * 64])
def test_install_app_rejects_bad_hashes(sha):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        apps.install_app(fake, URL, sha)
    assert fake.calls == []


def test_non_ascii_url_that_overflows_the_grammar_is_refused():
    fake = FakeTransport()
    with pytest.raises(ValidationError):  # \uXXXX escaping makes the request longer than the 1000-character grammar cap
        apps.install_app(fake, "http://example.com/" + "é" * 400, SHA)
    assert fake.calls == []


def test_install_app_failures():
    refused = FakeTransport({"app-install": b'{"returnValue":false,"errorText":"Hash mismatch"}\n'})
    with pytest.raises(RuntimeError, match="Hash mismatch"):
        apps.install_app(refused, URL, SHA)
    with pytest.raises(RuntimeError, match="malformed"):
        apps.install_app(FakeTransport({"app-install": b"garbage"}), URL, SHA)
    with pytest.raises(TransportError, match="timed out"):
        apps.install_app(FakeTransport({"app-install": TransportError("install timed out")}), URL, SHA)


def test_uninstall_app():
    fake = FakeTransport({"app-uninstall": b'{"returnValue":true}\n'})
    assert apps.uninstall_app(fake, "com.example.game") == "App removed"
    (call,) = fake.calls
    assert dispatcher.verb_of(call.command) == "app-uninstall"
    assert base64.b64decode(call.command.split(" ")[1]) == b"com.example.game"
    with pytest.raises(RuntimeError):
        apps.uninstall_app(FakeTransport({"app-uninstall": b'{"returnValue":false}'}), "com.example.game")


@pytest.mark.parametrize("app_id", ["", "../x", "a b", "a;id", "$(id)", "-rf", ".hidden", "a" * 101, "a\nb", None, 5])
def test_uninstall_app_rejects_bad_ids(app_id):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        apps.uninstall_app(fake, app_id)
    assert fake.calls == []
