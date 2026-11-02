import io
import json
import struct
import threading
import wave

import pytest

from tests.fakes import FakeTransport
from webos_foundry import process
from webos_foundry.errors import Cancelled, TvBusyError, ValidationError


def wav(width=2, channels=2, rate=48000, seconds=1, silent=False):
    data = io.BytesIO()
    with wave.open(data, "wb") as audio:
        audio.setparams((channels, width, rate, 0, "NONE", "not compressed"))
        sample = b"\0" * width if silent else (1).to_bytes(width, "little", signed=True)
        audio.writeframes(sample * channels * rate * seconds)
    return data.getvalue()


def test_input_audio_boundaries():
    assert process.input_audio(wav()) == 1
    assert process.input_audio(wav(seconds=30)) == 30
    for data in (wav(channels=1), wav(rate=44100), wav(width=4), wav(seconds=31), wav(silent=True),
                 wav()[:-4], b"not a wave", b"", b"x" * (8 * 1024 * 1024 + 1)):
        with pytest.raises(ValidationError):
            process.input_audio(data)


def capture_wav(frames_left=(0, 1024, -1024, 0), repeat=1):
    raw = io.BytesIO()
    with wave.open(raw, "wb") as audio:
        audio.setparams((2, 4, 48000, 0, "NONE", "not compressed"))
        audio.writeframes(struct.pack("<%di" % len(frames_left), *frames_left) * repeat)
    return raw.getvalue()


def test_normalize_capture():
    output, gain = process.normalize_capture(capture_wav())
    with wave.open(io.BytesIO(output), "rb") as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (2, 4, 48000)
        samples = struct.unpack("<iiii", audio.readframes(2))
    target = int((2**31 - 1) * 0.8)
    assert samples == (0, target, -target, 0) and gain == target / 1024
    for bad in (capture_wav()[:-4], wav(width=4, silent=True), wav(), b"junk"):
        with pytest.raises(RuntimeError):
            process.normalize_capture(bad)


IMAGE = {"codec_name": "png", "pix_fmt": "rgb24", "width": 960, "height": 540}


def test_image_contract():
    assert process.image_contract(IMAGE) == (960, 540)
    assert process.image_contract({**IMAGE, "codec_name": "mjpeg", "pix_fmt": "yuvj420p"}) == (960, 540)
    for invalid in ({"width": 0}, {"width": 4096}, {"height": 539}, {"pix_fmt": "rgb48be"}, {"codec_name": "h264"},
                    {"width": 640, "height": 480}, {"width": True}, {"width": 962, "height": 541}):
        with pytest.raises(ValidationError):
            process.image_contract({**IMAGE, **invalid})


def test_save_output_never_overwrites(tmp_path):
    target = tmp_path / "out.bin"
    process.save_output(b"a", target)
    assert target.read_bytes() == b"a" and [p.name for p in tmp_path.iterdir()] == ["out.bin"]
    with pytest.raises(FileExistsError):
        process.save_output(b"b", target)
    assert target.read_bytes() == b"a" and [p.name for p in tmp_path.iterdir()] == ["out.bin"]


def png4k(size=100):
    return (b"\x89PNG\r\n\x1a\n" + struct.pack(">I4sII", 13, b"IHDR", 3840, 2160) + b"\0" * size
            + b"\x00\x00\x00\x00IEND\xaeB`\x82")


@pytest.fixture
def image_env(monkeypatch, tmp_path):
    source = tmp_path / "in.png"
    source.write_bytes(b"png")
    monkeypatch.setattr(process, "_probe", lambda path: dict(IMAGE))
    monkeypatch.setattr(process, "_encode", lambda src, video: video.write_bytes(b"MP4DATA"))
    return source, tmp_path / "out.png"


def meta(profile, **kw):
    return json.dumps({"restored": True, "profile": profile, **kw}).encode() + b"\n"


def test_enhance_image_one_round_trip(image_env):
    source, out = image_env
    fake = FakeTransport({"process-image": meta("ai-picture-sr") + png4k()})
    logs = []
    result = process.enhance_image(fake, source, out, log=logs.append)
    assert fake.commands == ["process-image ai-picture-sr 960 540"]
    assert fake.calls[0].data == b"MP4DATA" and out.read_bytes() == png4k()
    assert result["restored"] is True and result["output"] == str(out) and result["displayed_on_tv"] is True
    assert len(logs) >= 3


@pytest.mark.parametrize("reply", [b"no newline", b"notjson\nxx", meta("standard") + png4k(), meta("ai-picture-sr", restored=False) + png4k(),
                                   meta("ai-picture-sr") + b"not png", meta("ai-picture-sr") + png4k()[:-1]])
def test_enhance_image_rejects_bad_replies(image_env, reply):
    source, out = image_env
    with pytest.raises(RuntimeError):
        process.enhance_image(FakeTransport({"process-image": reply}), source, out)
    assert not out.exists()


def test_enhance_image_input_validation(image_env, tmp_path):
    source, out = image_env
    fake = FakeTransport()
    with pytest.raises(ValidationError):
        process.enhance_image(fake, source, out, "nope")
    with pytest.raises(FileExistsError):
        process.enhance_image(fake, source, source)
    with pytest.raises(ValidationError):
        process.enhance_image(fake, tmp_path / "missing.png", out)
    text = tmp_path / "in.txt"
    text.write_bytes(b"x")
    with pytest.raises(ValidationError):
        process.enhance_image(fake, text, out)
    assert fake.calls == []


def test_enhance_image_cancel_before_transport(image_env):
    source, out = image_env
    cancel = threading.Event()
    cancel.set()
    fake = FakeTransport()
    with pytest.raises(Cancelled):
        process.enhance_image(fake, source, out, cancel=cancel)
    assert fake.calls == []


def test_enhance_image_busy_propagates(image_env):
    source, out = image_env
    with pytest.raises(TvBusyError):
        process.enhance_image(FakeTransport({"process-image": TvBusyError("TV is busy")}), source, out)


def test_enhance_audio(tmp_path):
    source, out = tmp_path / "in.wav", tmp_path / "out.wav"
    source.write_bytes(wav())
    fake = FakeTransport({"process-audio": meta("ai-sound") + capture_wav(repeat=3 * 48000 // 2)})
    result = process.enhance_audio(fake, source, out)
    assert fake.commands == ["process-audio ai-sound 1"] and fake.calls[0].data == wav() and fake.calls[0].timeout == 66
    assert result["peak_normalized_to"] == 0.8 and out.exists()
    with wave.open(str(out), "rb") as audio:
        assert audio.getnframes() == 3 * 48000


def test_enhance_audio_rejections(tmp_path):
    source, out = tmp_path / "in.wav", tmp_path / "out.wav"
    source.write_bytes(wav())
    fake = FakeTransport({"process-audio": meta("ai-sound") + capture_wav(repeat=10)})
    with pytest.raises(RuntimeError, match="Incomplete"):
        process.enhance_audio(fake, source, out)
    with pytest.raises(RuntimeError):
        process.enhance_audio(FakeTransport({"process-audio": meta("ai-sound", restored=False)}), source, out)
    with pytest.raises(RuntimeError, match="WAV"):
        process.enhance_audio(FakeTransport({"process-audio": meta("ai-sound") + b"junk"}), source, out)
    with pytest.raises(ValidationError):
        process.enhance_audio(fake, source, out, "bogus")
    source.write_bytes(wav(silent=True))
    with pytest.raises(ValidationError):
        process.enhance_audio(fake, source, out)
    assert not out.exists()


def test_wait_for_idle():
    fake = FakeTransport({"idle-wait": b""})
    assert process.wait_for_idle(fake) is None and fake.commands == ["idle-wait"]
    with pytest.raises(TvBusyError):
        process.wait_for_idle(FakeTransport({"idle-wait": TvBusyError("busy")}))


def test_profiles():
    assert process.IMAGE_PROFILES == ("ai-picture-sr", "ai-picture", "standard")
    assert process.AUDIO_PROFILES == ("ai-sound", "clear-voice", "standard")
