"""One bounded state producer shared by every authenticated fetch stream."""
import json
import threading
from collections import deque

MAX_EVENTS = 32
MAX_VIEWERS = 16
HEARTBEAT = 15


class Feed:
    def __init__(self, snapshot, interval=3):
        self.snapshot, self.interval = snapshot, interval
        self.condition = threading.Condition()
        self.stop = threading.Event()
        self.events = deque(maxlen=MAX_EVENTS)
        self.viewers = 0
        self.sequence = 0
        self.thread = None

    def subscribe(self):
        with self.condition:
            if self.stop.is_set() or self.viewers >= MAX_VIEWERS:
                return False
            self.viewers += 1
            if self.thread is None:
                self.thread = threading.Thread(target=self.run, daemon=True, name='foundry-events')
                self.thread.start()
            self.condition.notify_all()
            return True

    def unsubscribe(self):
        with self.condition:
            self.viewers = max(0, self.viewers - 1)
            self.condition.notify_all()

    def publish(self, state):
        encoded = json.dumps(state, separators=(',', ':'), allow_nan=False)
        if len(encoded.encode()) > 64 * 1024:
            raise ValueError('Event snapshot is too large')
        with self.condition:
            if not self.events or self.events[-1][1] != encoded:
                self.sequence += 1
                self.events.append((self.sequence, encoded))
                self.condition.notify_all()

    def run(self):
        while not self.stop.is_set():
            with self.condition:
                self.condition.wait_for(lambda: self.viewers or self.stop.is_set())
            if self.stop.is_set():
                break
            try:
                self.publish(self.snapshot())
            except Exception:
                self.publish({'status': None, 'connected': False, 'error': 'TV state unavailable'})
            self.stop.wait(self.interval)

    def next(self, after, timeout=None):
        with self.condition:
            self.condition.wait_for(lambda: self.stop.is_set() or (self.events and self.events[-1][0] > after),
                                    HEARTBEAT if timeout is None else timeout)
            return self.events[-1] if self.events and self.events[-1][0] > after else None

    def close(self):
        self.stop.set()
        with self.condition:
            self.condition.notify_all()
        if self.thread:
            self.thread.join(2)
