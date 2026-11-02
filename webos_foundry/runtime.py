"""Read-only foreground/lux monitoring and serialized design rotation ticks."""
import contextlib
import copy
import secrets
import threading
import time

from . import designs, notify, rotations, tv


def request_resume(config_dir_override=None):
    """Let an explicit CLI enable resume the running server without guessing its address/token."""
    designs._commit({"overlay-activation.json": {"id": secrets.token_hex(16)}}, config_dir_override)


def activation():
    return designs._read_file("overlay-activation.json").get("id")


class Runtime:
    def __init__(self, server, tv_lock, reserved):
        self.server, self.tv_lock, self.reserved = server, tv_lock, reserved
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.thread = None
        self.local = threading.local()
        self.card = None
        self.source = None
        self.paused = False
        self.until = 0
        self.started = 0
        self.baseline = None
        self.flags = {}
        self.lux = None
        self.lux_at = float('-inf')
        self.rotation_state = {}
        self.activation = activation()
        notify.OVERLAY_OBSERVERS.append(self.observe)

    @contextlib.contextmanager
    def producing(self, source):
        old = getattr(self.local, 'source', None)
        self.local.source = source
        try:
            yield
        finally:
            self.local.source = old

    def start(self):
        with self.lock:
            if self.thread is None and not self.stop.is_set():
                self.thread = threading.Thread(target=self.run, daemon=True, name='foundry-runtime')
                self.thread.start()

    @staticmethod
    def lifetime(card):
        return (bool(card.get('timeline')), tuple(frame['seconds'] for frame in card.get('timeline', [])),
                card.get('seconds', 0 if card.get('timeline') else 8))

    def observe(self, transport, card):
        if transport is not self.server.transport:
            return
        source = getattr(self.local, 'source', None) or 'manual'
        with self.lock:
            refresh = (not card.get('hide') and self.card is not None and time.monotonic() < self.until
                       and self.lifetime(card) == self.lifetime(self.card))
            self.source = source
            self.card = None if card.get('hide') else copy.deepcopy(card)
            if source in ('manual', 'scene'):
                self.paused = True
                self.activation = activation()
            duration = sum(frame['seconds'] for frame in card.get('timeline', [])) or card.get('seconds', 8)
            if card.get('timeline') and card.get('seconds', 0) > 0:
                duration = min(duration, card['seconds'])
            if not refresh:
                self.started = time.monotonic()
                self.until = self.started + duration if duration else float('inf')
                self.baseline = None
                self.flags = {}
                self.lux = None
                self.lux_at = float('-inf')
        self.start()
        if self.card and self._behavior(self.started).get('on_foreground') != 'keep' and self.baseline is None:
            try:
                self.baseline = tv.get_status(transport).get('app_id')
            except Exception:
                pass  # The overlay succeeded; unavailable telemetry is retried by the monitor.

    def resume(self):
        with self.lock:
            self.paused = False
            self.activation = activation()
            self.source = None
            self.rotation_state.clear()
        self.start()

    def held(self):
        with self.lock:
            return self.paused or (self.source == 'schedule' and self.card is not None and time.monotonic() < self.until)

    def snapshot(self):
        with self.lock:
            return {'visible': self.card is not None and time.monotonic() < self.until,
                    'source': self.source, 'paused': self.paused, **self.flags}

    def _behavior(self, now):
        card = self.card or {}
        frame = card
        elapsed = now - self.started
        for item in card.get('timeline', []):
            frame = item['card']
            if elapsed < item['seconds']:
                break
            elapsed -= item['seconds']
        policies = [card.get('behavior', {}), frame.get('behavior', {})]
        policies.extend(region.get('behavior', {}) for region in frame.get('regions', []))
        modes = [policy.get('on_foreground', 'keep') for policy in policies]
        return {'on_foreground': 'hide' if 'hide' in modes else 'shrink' if 'shrink' in modes else 'keep',
                'ambient_dim': any(policy.get('ambient_dim') for policy in policies)}

    def sample(self, status=None, now=None):
        now = time.monotonic() if now is None else now
        with self.lock:
            if self.card is None or now >= self.until:
                self.card = None
                return
            if not notify.overlay_state(self.server.get_transport())['running']:
                self.card = None
                return
            behavior = self._behavior(now)
            if not self.flags and not (behavior['ambient_dim'] or behavior['on_foreground'] != 'keep'):
                return
            transport = self.server.get_transport()
            if behavior.get('on_foreground', 'keep') != 'keep':
                status = status or tv.get_status(transport)
                app_id = status.get('app_id')
                if self.baseline is None and app_id:
                    self.baseline = app_id
                changed = bool(app_id and self.baseline and app_id != self.baseline)
            else:
                changed = False
            if behavior.get('ambient_dim') and now - self.lux_at >= 30:
                self.lux_at = now
                self.lux = tv.get_details(transport).get('lux')
            flags = {'hidden': changed and behavior.get('on_foreground') == 'hide',
                     'compact': changed and behavior.get('on_foreground') == 'shrink',
                     'dim': max(.2, min(1., self.lux / 200)) if behavior['ambient_dim'] and isinstance(self.lux, (int, float)) and not isinstance(self.lux, bool) else 1.}
            if flags != self.flags:
                if self.stop.is_set():
                    return
                notify.overlay_runtime(transport, flags)
                self.flags = flags

    def tick(self):
        if not self.tv_lock.acquire(blocking=False):
            return
        try:
            self.reserved()
            if activation() != self.activation:
                self.resume()
            self.sample()
            if self.held():
                return
            entries = rotations.load()
            enabled = [key for key, entry in entries.items() if entry['enabled']]
            if len(enabled) > 1:
                raise ValueError('Multiple enabled rotations; disable all but one before displaying')
            for entry_id, name in rotations.due(entries, self.rotation_state):
                with self.producing('rotation'):
                    designs.show(self.server.get_transport(), name)
        finally:
            self.tv_lock.release()

    def run(self):
        while not self.stop.wait(3):
            try:
                self.tick()
            except Exception as error:
                print('Overlay runtime: %s' % error, flush=True)

    def close(self):
        self.stop.set()
        if self.observe in notify.OVERLAY_OBSERVERS:
            notify.OVERLAY_OBSERVERS.remove(self.observe)
        if self.thread:
            self.thread.join(2)
