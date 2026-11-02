"""Offline test doubles: a scripted Transport that records every call and never opens a socket."""
import io
from dataclasses import dataclass


@dataclass
class Call:
    command: str
    data: bytes
    timeout: float

    @property
    def verb(self):
        return self.command.split(" ", 1)[0]


class FakePopen:
    """Just enough of subprocess.Popen for capture.stream(): stdout/stderr pipes, poll, terminate, wait, kill."""

    def __init__(self, stdout=b"", stderr=b""):
        self.stdout = io.BytesIO(stdout)
        self.stderr = io.BytesIO(stderr)
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


class FakeTransport:
    """`add(verb_or_command, response)` scripts a reply: bytes/str, an Exception to raise, or a callable
    `(command, data) -> bytes`. An exact command match wins over a verb match; anything unscripted fails the
    test. `calls` records every run()/run_streaming()."""

    def __init__(self, responses=None, stream=None):
        self.calls = []
        self.responses = dict(responses or {})
        self.stream = stream  # (stdout bytes, stderr bytes) for run_streaming

    def add(self, key, response):
        self.responses[key] = response
        return self

    def _lookup(self, command):
        for key in (command, command.split(" ", 1)[0]):
            if key in self.responses:
                return self.responses[key]
        raise AssertionError("FakeTransport: no scripted response for %r" % command)

    def run(self, command, data=b"", timeout=20):
        self.calls.append(Call(command, data, timeout))
        response = self._lookup(command)
        if isinstance(response, Exception):
            raise response
        if callable(response):
            response = response(command, data)
        return response.encode() if isinstance(response, str) else response

    def run_streaming(self, command, timeout=20):
        self.calls.append(Call(command, b"", timeout))
        stdout, stderr = self.stream if self.stream is not None else (b"", b"")
        self.last_popen = FakePopen(stdout, stderr)
        return self.last_popen

    @property
    def commands(self):
        return [call.command for call in self.calls]


def make_assets(root, vtcap=False):
    """A minimal fake tv-assets/ tree (every INSTALL_FILES entry plus the overlay app); returns `root`."""
    import json
    from webos_foundry.dispatcher import INSTALL_FILES
    root.mkdir(parents=True, exist_ok=True)
    for name in INSTALL_FILES:
        (root / name).write_bytes(("#!/bin/sh\n# " + name + "\n").encode())
    overlay = root / "overlay"
    overlay.mkdir(exist_ok=True)
    (overlay / "appinfo.json").write_text(json.dumps(
        {"id": "dev.webosfoundry.overlay", "version": "1.0.0", "vendor": "v", "title": "Overlay"}))
    for name in ("index.html", "overlay.js", "overlay.css", "icon.png"):
        (overlay / name).write_bytes(b"x" + name.encode())
    if vtcap:
        (root / "vtcap").mkdir(exist_ok=True)
        (root / "vtcap" / "vtcap").write_bytes(b"\x7fELF")
    return root
