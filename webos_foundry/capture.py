"""HDMI screenshot (luna capture service) and live frame stream (native vtcap client)."""
import struct
import subprocess
import zlib
from typing import Iterator, Optional, Tuple

from . import dispatcher
from .errors import ValidationError

MAGIC = b"C5F1"  # vtcap's stream header: MAGIC, u16le width, u16le height, then RGB24 frames
SHOT_FORMATS = {"jpg": (b"\xff\xd8\xff", "image/jpeg"), "png": (b"\x89PNG\r\n\x1a\n", "image/png")}


def _check_shot(width, height, fmt):
    if type(width) is not int or type(height) is not int or width % 2 or height % 2:
        raise ValidationError("Width and height must be even integers")
    if not 64 <= width <= 3840 or not 36 <= height <= 2160:
        raise ValidationError("Width must be 64-3840 and height 36-2160")
    if abs(width * 9 - height * 16) > 16:
        raise ValidationError("Height must keep the 16:9 picture shape")
    if fmt not in SHOT_FORMATS:
        raise ValidationError("Format must be jpg or png")


def screenshot(transport, width=1920, height=1080, fmt="jpg") -> Tuple[bytes, str]:
    """Capture the HDMI picture (no UI layer). Returns (image bytes, content type). The picture is
    whatever the connected source shows: private. The TV-side file is removed by the same command."""
    _check_shot(width, height, fmt)
    magic, kind = SHOT_FORMATS[fmt]
    data = transport.run(dispatcher.build_screenshot(width, height, fmt), timeout=30)
    if not data.startswith(magic):
        raise RuntimeError("TV returned a malformed %s capture" % fmt)
    return data, kind


def _read_exact(pipe, size):
    data = pipe.read(size)
    return data if len(data) == size else None


def stream(transport, width=160, height=90, fps=30, seconds=0, dump=2, info: Optional[dict] = None
           ) -> Iterator[Tuple[int, int, bytes]]:
    """Yield (width, height, rgb24) frames. Closing the generator stops the TV process.
    `dump` is the vtcapture tap: 0 scaler input, 1 scaler output, 2 display output (default), 3 blended,
    4 OSD, 5 histogram. `info`, if a dict, receives the client's final stats line as info["stats"].
    Arguments are validated now; the connection opens on the first next()."""
    command = dispatcher.build_stream_start(width, height, fps, seconds, dump)
    return _frames(transport, command, info)


def _frames(transport, command, info):
    proc = transport.run_streaming(command)
    try:
        header = _read_exact(proc.stdout, 8)
        if not header or header[:4] != MAGIC:
            raise RuntimeError(proc.stderr.read().decode(errors="replace").strip()[-500:]
                               or "vtcap did not start (is it installed? run `wof install --vtcap yes`)")
        w, h = struct.unpack("<HH", header[4:])
        while (frame := _read_exact(proc.stdout, w * h * 3)) is not None:
            yield w, h, frame
    finally:
        # The command is exec'd on the TV, so ending the ssh client ends the stream.
        if proc.poll() is None:
            proc.terminate()
        proc.stdout.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        stderr = proc.stderr.read().decode(errors="replace")
        proc.stderr.close()
        if info is not None:
            info["stats"] = stderr.strip()


def png(width, height, rgb) -> bytes:
    """Encode an RGB24 frame as PNG (stdlib only)."""
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))
    rows = b"".join(b"\0" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
