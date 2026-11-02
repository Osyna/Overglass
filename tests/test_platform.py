"""Real HTTP authorization/stream consumers plus deterministic runtime ticks."""
import http.client
import json
import os
import threading
from types import SimpleNamespace

import pytest

from tests.test_server import TOKEN, bearer, concrete, serve
from webos_foundry import access, events, notify, runtime, server
from webos_foundry.errors import ValidationError


def test_pin_hashes_are_salted_private_and_never_listed(tmp_path):
    access.save('first', {'pin': '123456', 'role': 'guest'}, tmp_path)
    access.save('second', {'pin': '123456', 'role': 'admin'}, tmp_path)
    users = access.load(tmp_path)
    assert users['first']['salt'] != users['second']['salt']
    assert users['first']['hash'] != users['second']['hash']
    assert os.stat(tmp_path / 'access.json').st_mode & 0o777 == 0o600
    assert all(set(row) == {'role', 'actions'} for row in access.public_users(tmp_path).values())
    assert 'power_off' not in users['first']['actions']
    assert 'volume' in users['first']['actions']
    for pin in ('123', '1234567890123', 'abcdef', 123456):
        with pytest.raises(ValidationError):
            access.save('bad', {'pin': pin, 'role': 'guest'}, tmp_path)


def test_login_bruteforce_expiry_revoke_and_cross_process_account_changes(tmp_path):
    now = [1000.]
    sessions = access.Sessions(tmp_path, clock=lambda: now[0])
    access.save('guest', {'pin': '123456', 'role': 'guest'}, tmp_path)
    for _ in range(access.LOGIN_LIMIT):
        with pytest.raises(access.LoginError) as error:
            sessions.login('guest', '000000', 'first-ip')
        assert error.value.status == 401
    with pytest.raises(access.LoginError) as error:
        sessions.login('guest', '123456', 'second-ip')
    assert error.value.status == 429  # account limit also prevents rotating source addresses
    now[0] += access.LOGIN_WINDOW + 1
    result = sessions.login('guest', '123456', 'first-ip')
    identity = sessions.resolve(result['token'])
    assert identity['role'] == 'guest'
    assert 'token' not in json.dumps(sessions.list()) and result['token'] not in json.dumps(sessions.sessions)
    sessions.revoke(session_id=identity['id'])
    assert sessions.resolve(result['token']) is None
    result = sessions.login('guest', '123456', 'first-ip')
    now[0] += access.SESSION_SECONDS
    assert sessions.resolve(result['token']) is None
    result = sessions.login('guest', '123456', 'first-ip')
    access.save('guest', {'pin': '654321', 'role': 'admin'}, tmp_path)
    assert sessions.resolve(result['token']) is None  # CLI edits revoke too, not only API edits


def test_auth_memory_bounds(tmp_path, monkeypatch):
    monkeypatch.setattr(access, 'MAX_SESSIONS', 2)
    monkeypatch.setattr(access, 'MAX_CLIENTS', 3)
    sessions = access.Sessions(tmp_path)
    access.save('guest', {'pin': '123456', 'role': 'guest'}, tmp_path)
    tokens = [sessions.login('guest', '123456', 'ip')['token'] for _ in range(3)]
    assert len(sessions.sessions) == 2 and sessions.resolve(tokens[0]) is None
    for index in range(20):
        with pytest.raises(access.LoginError):
            sessions.login('missing-%d' % index, '000000', str(index))
    assert len(sessions.attempts) <= 3


@pytest.mark.parametrize('auth_mode', ['token', 'disabled'])
def test_guest_is_deny_by_default_even_on_tokenless_loopback(serve, monkeypatch, auth_mode):
    monkeypatch.setattr(server.tv, 'get_status', lambda _: {'power': 'on', 'app_id': 'hdmi1', 'secret': 'never expose'})
    monkeypatch.setattr(server.tv, 'remote', lambda *args: 'sent')
    app = serve(auth_mode=auth_mode)
    assert app.json('PUT', '/api/access/users/guest', {'pin': '123456', 'role': 'guest'})[0] == 200
    status, login = app.json('POST', '/api/access/login', {'name': 'guest', 'pin': '123456'})
    assert status == 200 and login['role'] == 'guest' and 'HTTP' in login['warning']
    headers = bearer(login['token'])
    assert app.json('GET', '/api/status', headers=headers)[1] == {
        'power': 'on', 'app_id': 'hdmi1', 'source': None, 'volume': None, 'muted': None}
    assert app.json('POST', '/api/remote/home', headers=headers)[0] == 200
    assert 'volume' in login['actions']
    assert app.json('POST', '/api/remote/volume', {'value': 41}, headers=headers) == (
        200, {'action': 'volume', 'message': 'sent'})
    assert app.json('POST', '/api/remote/power_off', headers=headers)[0] == 403
    for route in server.ROUTES:
        if route['path'] in ('/api/status', '/api/remote/{action}', '/api/access/logout'):
            continue
        assert app.json(route['method'], concrete(route), {} if route['method'] != 'GET' else None, headers)[0] == 403, route['path']
    assert app.json('GET', '/api/no-such-path', headers=headers)[0] == 403
    assert app.json('GET', '/api/status', headers=bearer('expired-or-unknown'))[0] == 401
    assert app.json('PUT', '/api/access/users/guest', {'pin': '654321', 'role': 'guest'})[0] == 200
    assert app.json('GET', '/api/status', headers=headers)[0] == 401


def test_volume_grants_preserve_restricted_accounts_and_sessions(serve, monkeypatch):
    calls = []
    monkeypatch.setattr(server.tv, 'remote', lambda t, action, value=None: calls.append((action, value)) or 'sent')
    app = serve()
    restricted = {'pin': '123456', 'role': 'guest', 'actions': ['volume_up']}
    assert app.json('PUT', '/api/access/users/restricted', restricted)[0] == 200
    _, login = app.json('POST', '/api/access/login', {'name': 'restricted', 'pin': '123456'})
    headers = bearer(login['token'])
    assert login['actions'] == ['volume_up']
    assert app.json('PUT', '/api/access/users/new', {'pin': '654321', 'role': 'guest'})[0] == 200
    assert app.json('GET', '/api/access/users')[1]['users']['restricted']['actions'] == ['volume_up']
    assert app.json('POST', '/api/remote/volume', {'value': 20}, headers=headers)[0] == 403
    assert app.json('POST', '/api/remote/volume_up', headers=headers)[0] == 200
    assert calls == [('volume_up', None)]
    assert app.json('PUT', '/api/access/users/volume-only', {
        'pin': '123456', 'role': 'guest', 'actions': ['volume']})[0] == 200
    _, login = app.json('POST', '/api/access/login', {'name': 'volume-only', 'pin': '123456'})
    headers = bearer(login['token'])
    assert login['actions'] == ['volume']
    assert app.json('POST', '/api/remote/volume', {'value': 100}, headers=headers)[0] == 200
    assert app.json('POST', '/api/remote/volume_up', headers=headers)[0] == 403
    assert calls == [('volume_up', None), ('volume', 100)]


def test_http_login_limit_and_admin_session_revoke(serve):
    app = serve(bind='0.0.0.0', token=TOKEN, transport=None)
    assert app.json('PUT', '/api/access/users/admin', {'pin': '123456', 'role': 'admin'}, bearer())[0] == 200
    _, login = app.json('POST', '/api/access/login', {'name': 'admin', 'pin': '123456'})
    auth = bearer(login['token'])
    status, listing = app.json('GET', '/api/access/sessions', headers=auth)
    assert status == 200 and len(listing['sessions']) == 1
    assert login['token'] not in json.dumps(listing) and 'hash' not in json.dumps(listing)
    session_id = listing['sessions'][0]['id']
    assert app.json('DELETE', '/api/access/sessions/' + session_id, headers=bearer())[0] == 200
    assert app.json('GET', '/api/access/users', headers=auth)[0] == 401
    for index in range(access.LOGIN_LIMIT - 1):
        assert app.json('POST', '/api/access/login', {'name': 'missing-' + str(index), 'pin': '000000'})[0] == 401
    assert app.json('POST', '/api/access/login', {'name': 'admin', 'pin': '123456'})[0] == 429


def test_feed_bounds_dedup_change_and_shutdown():
    feed = events.Feed(lambda: {})
    feed.publish({'status': {'power': 'on'}})
    feed.publish({'status': {'power': 'on'}})
    assert feed.sequence == 1
    for index in range(events.MAX_EVENTS + 20):
        feed.publish({'status': {'volume': index}})
    assert len(feed.events) == events.MAX_EVENTS
    assert json.loads(feed.next(0)[1])['status']['volume'] == events.MAX_EVENTS + 19
    with pytest.raises(ValueError):
        feed.publish({'status': 'x' * 65536})
    feed.viewers = events.MAX_VIEWERS
    assert not feed.subscribe()
    woke = threading.Event()
    waiter = threading.Thread(target=lambda: (feed.next(feed.sequence, 30), woke.set()))
    waiter.start()
    feed.close()
    assert woke.wait(1)
    waiter.join()
    assert not feed.subscribe()


def _read_state(response):
    while True:
        line = response.readline()
        assert line, 'stream closed before state'
        if line.startswith(b'data: '):
            return json.loads(line[6:])


def test_fetch_sse_shared_producer_change_reconnect_and_shutdown(serve, monkeypatch):
    value = {'power': 'on'}
    calls = []
    monkeypatch.setattr(server.tv, 'get_status', lambda _: calls.append(1) or dict(value))
    app = serve(bind='0.0.0.0', token=TOKEN)
    app.server.events.interval = .02
    clients = [http.client.HTTPConnection('127.0.0.1', app.port, timeout=3) for _ in range(2)]
    try:
        for connection in clients:
            connection.request('GET', '/api/events', headers=bearer())
        streams = [connection.getresponse() for connection in clients]
        assert all(response.status == 200 and response.getheader('Content-Type') == 'text/event-stream' for response in streams)
        assert _read_state(streams[0])['status']['power'] == 'on'
        assert _read_state(streams[1])['status']['power'] == 'on'
        producer = app.server.events.thread
        assert producer is not None and app.server.events.viewers == 2
        value['power'] = 'off'
        assert _read_state(streams[0])['status']['power'] == 'off'
        assert _read_state(streams[1])['status']['power'] == 'off'
        assert app.server.events.thread is producer  # no producer per subscriber
        reconnect = http.client.HTTPConnection('127.0.0.1', app.port, timeout=3)
        clients.append(reconnect)
        reconnect.request('GET', '/api/events', headers=bearer())
        replay = reconnect.getresponse()
        assert _read_state(replay)['status']['power'] == 'off'  # reconnect gets the latest full snapshot
        assert app.server.events.thread is producer
        app.server.events.close()
        assert streams[0].read() == b'\n'
        assert streams[1].read() == b'\n'
    finally:
        for connection in clients:
            connection.close()
    assert app.json('GET', '/api/events?token=' + TOKEN)[0] == 401  # no query-token authentication


def _runtime(monkeypatch):
    monkeypatch.setattr(runtime, 'activation', lambda: None)
    transport = object()
    fake = SimpleNamespace(transport=transport, get_transport=lambda: transport)
    controller = runtime.Runtime(fake, threading.Lock(), lambda: None)
    monkeypatch.setattr(controller, 'start', lambda: None)
    monkeypatch.setattr(notify, 'overlay_state', lambda _: {'running': True})
    return controller, transport


def test_runtime_actual_foreground_lux_dedup_no_rerender_and_remote_dismissal(monkeypatch):
    controller, transport = _runtime(monkeypatch)
    status = {'app_id': 'hdmi1'}
    lux_reads, updates = [], []
    monkeypatch.setattr(runtime.tv, 'get_status', lambda _: dict(status))
    monkeypatch.setattr(runtime.tv, 'get_details', lambda _: lux_reads.append(1) or {'lux': 10})
    monkeypatch.setattr(notify, 'overlay_runtime', lambda _, flags: updates.append(dict(flags)))
    monkeypatch.setattr(notify, 'overlay_show', lambda *args: pytest.fail('monitor must not rerender'))
    try:
        controller.observe(transport, {'seconds': 0, 'behavior': {'on_foreground': 'shrink', 'ambient_dim': True}})
        controller.sample(now=controller.started)
        status['app_id'] = 'home'
        controller.sample(now=controller.started + 3)
        controller.sample(now=controller.started + 6)
        assert updates == [{'hidden': False, 'compact': False, 'dim': .2}, {'hidden': False, 'compact': True, 'dim': .2}]
        assert lux_reads == [1]
        controller.sample(now=controller.started + 31)
        assert lux_reads == [1, 1]
        monkeypatch.setattr(notify, 'overlay_state', lambda _: {'running': False})
        controller.sample(now=controller.started + 32)
        assert controller.card is None
    finally:
        controller.close()


def test_runtime_rotations_reserved_priority_manual_pause_and_explicit_resume(monkeypatch):
    controller, transport = _runtime(monkeypatch)
    shown = []
    entry = {'id': 'r', 'designs': ['one', 'two'], 'interval_seconds': 15, 'enabled': True}
    monkeypatch.setattr(runtime.rotations, 'load', lambda: {'r': entry})
    clock = [100.]
    monkeypatch.setattr(runtime.rotations.time, 'time', lambda: clock[0])
    monkeypatch.setattr(runtime.designs, 'show', lambda _, name: shown.append(name))
    try:
        controller.tick()
        controller.tick()
        assert shown == ['one']
        clock[0] += 15
        controller.tick()
        assert shown == ['one', 'two']
        controller.observe(transport, {'hide': True})
        clock[0] += 100
        controller.tick()
        assert shown == ['one', 'two'] and controller.held()
        controller.resume()
        controller.tick()
        assert shown[-1] == 'one'
        controller.tv_lock.acquire()
        try:
            clock[0] += 15
            controller.tick()
        finally:
            controller.tv_lock.release()
        assert shown == ['one', 'two', 'one']
        controller.reserved = lambda: (_ for _ in ()).throw(server.ApiError(409, 'reserved'))
        with pytest.raises(server.ApiError):
            controller.tick()
        assert shown == ['one', 'two', 'one']
    finally:
        controller.close()


def test_local_design_theme_revision_import_and_rotation_routes_never_pair(serve, monkeypatch):
    app = serve(transport=None)
    monkeypatch.setattr(app.server, 'get_transport', lambda: pytest.fail('local routes must not acquire TV transport'))
    first = {'root': {'type': 'text', 'text': 'First'}}
    second = {'root': {'type': 'text', 'text': 'Second'}}
    assert app.json('PUT', '/api/themes/night', {'accent': '#80ccff'})[0] == 200
    assert app.json('GET', '/api/themes')[1]['themes']['night']['accent'] == '#80ccff'
    assert app.json('PUT', '/api/designs/one', first)[0] == 200
    assert app.json('PUT', '/api/designs/one', second)[0] == 200
    history = app.json('GET', '/api/designs/one/history')[1]['versions']
    assert len(history) == 1 and history[0]['card'] == first
    assert app.json('POST', '/api/designs/one/restore', {'id': history[0]['id']})[1]['card'] == first
    assert app.json('POST', '/api/designs/one/rename', {'name': 'renamed'})[0] == 200
    assert len(app.json('GET', '/api/designs/renamed/history')[1]['versions']) == 2
    bundle = app.json('GET', '/api/designs/renamed/export')[1]
    assert app.json('POST', '/api/designs/import', {'bundle': bundle, 'name': 'imported'})[0] == 200
    assert app.json('POST', '/api/designs/import', {'bundle': bundle, 'name': 'imported'})[0] == 400
    assert app.json('POST', '/api/designs/resolve', first) == (200, {'card': first})
    body = {'designs': ['renamed', 'imported'], 'interval_seconds': 15, 'enabled': False}
    status, saved = app.json('POST', '/api/rotations', body)
    assert status == 200
    assert app.json('GET', '/api/rotations')[1]['entries'][saved['id']]['designs'] == body['designs']
    assert app.json('PUT', '/api/rotations/' + saved['id'], {**body, 'interval_seconds': 30})[0] == 200
    assert app.json('DELETE', '/api/rotations/' + saved['id'])[0] == 200
    assert app.json('DELETE', '/api/themes/night')[0] == 200


def test_design_capability_values_are_post_only_and_scalar_safe(serve, monkeypatch):
    app = serve()
    shown = []
    monkeypatch.setattr(notify, 'overlay_show', lambda _, card: shown.append(card) or 'shown')
    card = {'root': {'type': 'text', 'text': 'Hello {{name}}'}}
    assert app.json('PUT', '/api/designs/greeting', card)[0] == 200
    _, capability = app.json('POST', '/api/webhooks', {'design': 'greeting'})
    assert app.json('GET', capability['url'])[0] == 200 and shown == []
    assert app.json('POST', capability['url'], {'values': {'name': 'Ada'}}) == (200, {'message': 'shown'})
    assert shown[0]['root']['text'] == 'Hello Ada'
    assert app.json('POST', capability['url'], {'values': {'name': {'type': 'image', 'src': 'http://private'}}})[0] == 400
    assert app.json('POST', capability['url'], {'values': {'/root/type': 'image'}})[0] == 400
    assert len(shown) == 1


def test_enabled_rotations_and_addons_cannot_compete_or_clear_manual_pause(serve):
    app = serve()
    card = {'root': {'type': 'text', 'text': 'One'}}
    app.json('PUT', '/api/designs/one', card)
    entry = {'designs': ['one'], 'interval_seconds': 60, 'enabled': True}
    _, rotation = app.json('POST', '/api/rotations', entry)
    assert app.json('POST', '/api/rotations', entry)[0] == 400
    assert app.json('PUT', '/api/addons/football', {'enabled': True, 'params': {}})[0] == 409
    app.server.runtime.observe(app.server.transport, {'hide': True})
    disabled = {**entry, 'enabled': False}
    assert app.json('PUT', '/api/rotations/' + rotation['id'], disabled)[0] == 200
    assert app.server.runtime.held()  # editing a disabled source is not an explicit resume
    assert app.json('PUT', '/api/rotations/' + rotation['id'], entry)[0] == 200
    assert not app.server.runtime.held()


def test_binding_validation_preserves_config_without_fetching(serve, monkeypatch):
    from webos_foundry import bindings
    app = serve(transport=None)
    monkeypatch.setattr(bindings.datafetch, 'fetch_json', lambda *args, **kwargs: pytest.fail('validation must not fetch'))
    card = {'root': {'type': 'text', 'text': 'Waiting'}, 'bindings': [
        {'target': '/root/text', 'source': {'kind': 'json', 'url': 'https://example.org/state', 'path': 'value'}}]}
    status, verdict = app.json('POST', '/api/overlay/validate', card)
    assert status == 200 and verdict['card']['bindings'][0]['target'] == '/root/text'
    bad = {**card, 'bindings': [{**card['bindings'][0], 'target': '/root/type'}]}
    assert app.json('POST', '/api/overlay/validate', bad)[0] == 400


def test_sse_heartbeat_and_expiring_session_close_without_secrets(serve, monkeypatch):
    monkeypatch.setattr(events, 'HEARTBEAT', .02)
    app = serve(bind='0.0.0.0', token=TOKEN, transport=None)
    clock = [1000.]
    app.server.sessions.clock = lambda: clock[0]
    app.json('PUT', '/api/access/users/admin', {'pin': '123456', 'role': 'admin'}, bearer())
    _, login = app.json('POST', '/api/access/login', {'name': 'admin', 'pin': '123456'})
    connection = http.client.HTTPConnection('127.0.0.1', app.port, timeout=3)
    try:
        connection.request('GET', '/api/events', headers=bearer(login['token']))
        response = connection.getresponse()
        state = _read_state(response)
        assert state['status'] is None and state['connected'] is False
        assert login['token'] not in json.dumps(state) and 'sessions' not in state
        assert response.readline() == b'\n'
        assert response.readline() == b': heartbeat\n'
        clock[0] = login['expires'] + 1
        assert b'data:' not in response.read()  # expiry closes even an otherwise unchanged feed
    finally:
        connection.close()


def test_runtime_preserves_live_lifetime_and_applies_frame_region_policy(monkeypatch):
    controller, transport = _runtime(monkeypatch)
    monkeypatch.setattr(runtime.tv, 'get_status', lambda _: {'app_id': 'hdmi1'})
    updates = []
    monkeypatch.setattr(notify, 'overlay_runtime', lambda _, flags: updates.append(flags))
    card = {'timeline': [
        {'seconds': 5, 'card': {'root': {'type': 'text', 'text': 'First'}}},
        {'seconds': 5, 'card': {'regions': [{'position': 'top-left', 'root': {'type': 'text', 'text': 'Second'},
                                          'behavior': {'on_foreground': 'hide'}}]}}]}
    try:
        controller.observe(transport, card)
        started, until = controller.started, controller.until
        controller.observe(transport, card)
        assert (controller.started, controller.until) == (started, until)
        controller.baseline = 'hdmi1'
        controller.sample(status={'app_id': 'home'}, now=started + 6)
        assert updates[-1]['hidden'] is True
        controller.observe(transport, {'seconds': 2, **card})
        assert controller.until - controller.started == 2
    finally:
        controller.close()


def test_cli_new_local_commands_and_boolean_private_opt_in(tmp_path, monkeypatch, capsys):
    from webos_foundry import cli
    args = ['--config-dir', str(tmp_path)]
    source = tmp_path / 'card.json'
    source.write_text(json.dumps({'root': {'type': 'text', 'text': 'One'}}))
    assert cli.main(args + ['design', 'set', 'one', str(source)]) == 0
    capsys.readouterr()
    assert cli.main(args + ['design', 'export', 'one']) == 0
    bundle = json.loads(capsys.readouterr().out)
    source.write_text(json.dumps(bundle))
    assert cli.main(args + ['design', 'import', str(source), '--name', 'two']) == 0
    capsys.readouterr()
    assert cli.main(args + ['rotation', 'set', 'one', 'two', '--disabled']) == 0
    capsys.readouterr()
    assert cli.main(args + ['rotation', 'list']) == 0
    assert len(json.loads(capsys.readouterr().out)) == 1
    monkeypatch.setattr(cli.getpass, 'getpass', lambda _: '123456')
    assert cli.main(args + ['access', 'set', 'guest']) == 0
    capsys.readouterr()
    assert cli.main(args + ['access', 'list']) == 0
    assert json.loads(capsys.readouterr().out)['guest']['role'] == 'guest'
    assert cli._parse_params(['allow_private=true', 'token=secret']) == {'allow_private': True, 'token': 'secret'}


def test_server_close_stops_shared_producer_monitor_and_observer(serve, monkeypatch):
    app = serve()
    monkeypatch.setattr(server.tv, 'get_status', lambda _: {'power': 'on'})
    assert app.server.events.subscribe()
    observer = app.server.runtime.observe
    assert observer in notify.OVERLAY_OBSERVERS
    app.close()
    assert app.server.events.stop.is_set() and app.server.runtime.stop.is_set()
    assert not app.server.events.thread.is_alive() and not app.server.runtime.thread.is_alive()
    assert observer not in notify.OVERLAY_OBSERVERS


def test_cli_enable_signal_resumes_paused_running_server(tmp_path, monkeypatch):
    monkeypatch.setenv('WEBOS_FOUNDRY_HOME', str(tmp_path))
    transport = object()
    fake = SimpleNamespace(transport=transport, get_transport=lambda: transport)
    controller = runtime.Runtime(fake, threading.Lock(), lambda: None)
    monkeypatch.setattr(controller, 'start', lambda: None)
    monkeypatch.setattr(runtime.rotations, 'load', lambda: {})
    try:
        controller.observe(transport, {'hide': True})
        assert controller.held()
        runtime.request_resume(tmp_path)
        controller.tick()
        assert not controller.held()
        assert os.stat(tmp_path / 'overlay-activation.json').st_mode & 0o777 == 0o600
    finally:
        controller.close()


def test_guest_logout_revokes_only_own_session(serve, monkeypatch):
    monkeypatch.setattr(server.tv, 'get_status', lambda _: {'power': 'on'})
    app = serve()
    app.json('PUT', '/api/access/users/guest', {'pin': '123456', 'role': 'guest'})
    first = app.json('POST', '/api/access/login', {'name': 'guest', 'pin': '123456'})[1]['token']
    second = app.json('POST', '/api/access/login', {'name': 'guest', 'pin': '123456'})[1]['token']
    assert app.json('POST', '/api/access/logout', headers=bearer(first)) == (200, {'message': 'Logged out'})
    assert app.json('GET', '/api/status', headers=bearer(first))[0] == 401
    assert app.json('GET', '/api/status', headers=bearer(second))[0] == 200
    assert app.json('GET', '/api/access/sessions', headers=bearer(second))[0] == 403
