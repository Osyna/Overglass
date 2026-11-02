import struct
import zlib

import pytest

from tests.fakes import FakeTransport
from webos_foundry import capture
from webos_foundry.errors import ValidationError

JPG = b"\xff\xd8\xff\xe0data"
PNG = b"\x89PNG\r\n\x1a\nrest"


def test_screenshot_formats():
    fake = FakeTransport({"screenshot": JPG})
    assert capture.screenshot(fake) == (JPG, "image/jpeg")
    assert fake.commands == ["screenshot 1920 1080 jpg"]
    fake = FakeTransport({"screenshot": PNG})
    assert capture.screenshot(fake, 1280, 720, "png") == (PNG, "image/png")
    assert fake.commands == ["screenshot 1280 720 png"]


@pytest.mark.parametrize("args", [(1921, 1080, "jpg"), (1920, 1081, "jpg"), (1920, 1080, "gif"), (63, 36, "jpg"),
                                  (3842, 2160, "jpg"), (1920, 1000, "jpg"), ("1920", 1080, "jpg"), (True, 1080, "jpg"),
                                  (1920.0, 1080, "jpg")])
def test_screenshot_validates_before_transport(args):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        capture.screenshot(fake, *args)
    assert fake.calls == []


def test_screenshot_rejects_wrong_magic():
    with pytest.raises(RuntimeError, match="malformed jpg"):
        capture.screenshot(FakeTransport({"screenshot": PNG}), 1920, 1080, "jpg")
    with pytest.raises(RuntimeError):
        capture.screenshot(FakeTransport({"screenshot": b""}))


def frames(w, h, count):
    return [bytes([i]) * (w * h * 3) for i in range(count)]


def test_stream_parses_header_and_yields_frames():
    data = b"C5F1" + struct.pack("<HH", 4, 2) + b"".join(frames(4, 2, 3))
    fake = FakeTransport(stream=(data, b"stats: 3 frames\n"))
    info = {}
    out = list(capture.stream(fake, 16, 10, 15, 2, 1, info=info))
    assert [(w, h, f) for w, h, f in out] == [(4, 2, f) for f in frames(4, 2, 3)]
    assert fake.commands == ["stream-start 16 10 15 2 1"]
    assert fake.last_popen.stdout.closed
    assert info["stats"] == "stats: 3 frames" and fake.last_popen.stderr.closed


def test_stream_drops_trailing_partial_frame():
    data = b"C5F1" + struct.pack("<HH", 2, 2) + b"\x01" * 12 + b"\x02" * 5
    assert len(list(capture.stream(FakeTransport(stream=(data, b"")), 16, 10))) == 1


def test_stream_stops_the_process_when_closed_early():
    data = b"C5F1" + struct.pack("<HH", 2, 2) + b"\x01" * 12 * 5
    fake = FakeTransport(stream=(data, b""))
    generator = capture.stream(fake, 16, 10)
    next(generator)
    generator.close()
    assert fake.last_popen.terminated and fake.last_popen.stdout.closed


def test_stream_bad_header_reports_stderr():
    fake = FakeTransport(stream=(b"nope....", b"vtcap: no role\n"))
    with pytest.raises(RuntimeError, match="vtcap: no role"):
        list(capture.stream(fake, 16, 10))
    assert fake.last_popen.terminated
    with pytest.raises(RuntimeError, match="did not start"):
        list(capture.stream(FakeTransport(stream=(b"", b"")), 16, 10))


@pytest.mark.parametrize("args", [(16, 10, 30, 0, 6), (16, 10, 1000, 0, 2), (16, 10, 30, 10000, 2), (1, 10, 30, 0, 2),
                                  (16.0, 10, 30, 0, 2)])
def test_stream_validates_eagerly(args):
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        capture.stream(fake, *args)  # raised by the call itself, not by iterating
    assert fake.calls == []


def test_png_encoder_roundtrips_structure():
    rgb = bytes(range(12))  # 2x2
    data = capture.png(2, 2, rgb)
    assert data.startswith(b"\x89PNG\r\n\x1a\n") and data.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82")
    length, tag = struct.unpack(">I4s", data[8:16])
    assert tag == b"IHDR" and struct.unpack(">II", data[16:24]) == (2, 2)
    idat = data.index(b"IDAT")
    size = struct.unpack(">I", data[idat - 4:idat])[0]
    rows = zlib.decompress(data[idat + 4:idat + 4 + size])
    assert rows == b"\0" + rgb[:6] + b"\0" + rgb[6:]
