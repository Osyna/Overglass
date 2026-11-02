"""Private PIN accounts and bounded, expiring in-memory sessions."""
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
import time
from collections import OrderedDict, deque

from .config import config_dir
from .errors import ValidationError

LOCK = threading.RLock()
DEFAULT_ACTIONS = ('home', 'back', 'up', 'down', 'left', 'right', 'ok', 'hdmi', 'volume', 'volume_up', 'volume_down', 'mute', 'unmute')
ALL_ACTIONS = DEFAULT_ACTIONS + ('wake', 'power_off')
SESSION_SECONDS = 8 * 3600
MAX_SESSIONS = 256
MAX_CLIENTS = 1024
LOGIN_LIMIT = 5
LOGIN_WINDOW = 300


class LoginError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def load(config_dir_override=None):
    try:
        users = json.loads((config_dir(config_dir_override) / 'access.json').read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(users, dict):
        raise ValidationError('access.json is malformed')
    return users


def _write(users, directory):
    directory = config_dir(directory)
    directory.mkdir(parents=True, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix='.access-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(users, handle)
        os.replace(path, directory / 'access.json')
    finally:
        if os.path.exists(path):
            os.unlink(path)


def public_users(config_dir_override=None):
    return {name: {key: row[key] for key in ('role', 'actions')} for name, row in load(config_dir_override).items()}


def save(name, body, config_dir_override=None):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,60}', name):
        raise ValidationError('Account name must be 1-60 letters, numbers, dots, underscores or hyphens')
    if set(body) - {'pin', 'role', 'actions'}:
        raise ValidationError('An account takes pin, role and optional actions')
    pin, role = body.get('pin'), body.get('role')
    if not isinstance(pin, str) or not re.fullmatch(r'[0-9]{6,12}', pin):
        raise ValidationError('PIN must be 6-12 digits')
    if role not in ('admin', 'guest'):
        raise ValidationError('Role must be admin or guest')
    actions = body.get('actions', list(DEFAULT_ACTIONS))
    if not isinstance(actions, list) or not all(isinstance(a, str) and a in ALL_ACTIONS for a in actions):
        raise ValidationError('Unknown guest remote action')
    salt = secrets.token_bytes(16)
    row = {'role': role, 'actions': sorted(set(actions)), 'salt': salt.hex(),
           'hash': hashlib.scrypt(pin.encode(), salt=salt, n=16384, r=8, p=1).hex()}
    with LOCK:
        users = load(config_dir_override)
        if name not in users and len(users) >= 100:
            raise ValidationError('At most 100 accounts are allowed')
        users[name] = row
        _write(users, config_dir_override)
    return {'role': role, 'actions': row['actions']}


def delete(name, config_dir_override=None):
    with LOCK:
        users = load(config_dir_override)
        if name not in users:
            raise ValidationError('No such account')
        del users[name]
        _write(users, config_dir_override)


class Sessions:
    def __init__(self, directory=None, clock=time.time):
        self.directory, self.clock = directory, clock
        self.lock = threading.RLock()
        self.sessions = OrderedDict()
        self.attempts = OrderedDict()

    def _prune(self):
        now = self.clock()
        users = load(self.directory) if self.sessions else {}
        for key, row in list(self.sessions.items()):
            user = users.get(row['name'])
            if row['expires'] <= now or not user or not hmac.compare_digest(user['hash'], row['credential']):
                del self.sessions[key]
        for key, attempts in list(self.attempts.items()):
            while attempts and attempts[0] <= now - LOGIN_WINDOW:
                attempts.popleft()
            if not attempts:
                del self.attempts[key]

    def login(self, name, pin, client):
        with self.lock:
            self._prune()
            # Both address and account limits prevent name cycling and distributed PIN guessing.
            keys = [('client', str(client)), ('name', str(name)[:60])]
            if any(len(self.attempts.get(key, ())) >= LOGIN_LIMIT for key in keys):
                raise LoginError(429, 'Too many login attempts; wait five minutes')
            for key in keys:
                self.attempts.setdefault(key, deque()).append(self.clock())
                self.attempts.move_to_end(key)
            while len(self.attempts) > MAX_CLIENTS:
                self.attempts.popitem(last=False)
            row = load(self.directory).get(name) if isinstance(name, str) else None
            valid_pin = isinstance(pin, str) and re.fullmatch(r'[0-9]{6,12}', pin)
            salt = bytes.fromhex(row['salt']) if row else b'\0' * 16
            digest = hashlib.scrypt((pin if valid_pin else '').encode(), salt=salt, n=16384, r=8, p=1).hex()
            if not row or not valid_pin or not hmac.compare_digest(digest, row['hash']):
                raise LoginError(401, 'Invalid account name or PIN')
            token = secrets.token_urlsafe(32)
            session = {'id': secrets.token_hex(12), 'name': name, 'role': row['role'],
                       'actions': row['actions'], 'credential': row['hash'], 'expires': self.clock() + SESSION_SECONDS}
            self.sessions[hashlib.sha256(token.encode()).hexdigest()] = session
            while len(self.sessions) > MAX_SESSIONS:
                self.sessions.popitem(last=False)
            return {'token': token, 'role': row['role'], 'actions': row['actions'], 'expires': session['expires']}

    def resolve(self, token):
        with self.lock:
            self._prune()
            key = hashlib.sha256(token.encode()).hexdigest() if token else None
            row = self.sessions.get(key)
            return {k: v for k, v in row.items() if k != 'credential'} if row else None

    def list(self):
        with self.lock:
            self._prune()
            return [{k: row[k] for k in ('id', 'name', 'role', 'expires')} for row in self.sessions.values()]

    def revoke(self, session_id=None, name=None):
        with self.lock:
            for key, row in list(self.sessions.items()):
                if row['id'] == session_id or row['name'] == name:
                    del self.sessions[key]


def allowed(session, method, path):
    if session['role'] == 'admin':
        return True
    if method == 'GET' and path == '/api/status':
        return True
    if method == 'POST' and path == '/api/access/logout':
        return True
    return method == 'POST' and path.startswith('/api/remote/') and path.removeprefix('/api/remote/') in session['actions']
