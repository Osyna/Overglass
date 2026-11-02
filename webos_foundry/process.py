"""Picture/sound AI-pipeline processing: host-side validation, one round trip to the TV, result checks.

The TV-side scripts own their private workspace and the restoration of every setting they touch; this
module only validates the input, sends it as stdin of `process-image`/`process-audio` and checks what
comes back (ARCHITECTURE.md §3, §9: stdout = one JSON metadata line, "\\n", then the raw result bytes).
"""
import io
import json
import math
import os
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

from . import dispatcher
from .errors import Cancelled, ValidationError

IMAGE_PROFILES = ("ai-picture-sr", "ai-picture", "standard")
AUDIO_PROFILES = ("ai-sound", "clear-voice", "standard")
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
PNG_END = b"\x00\x00\x00\x00IEND\xaeB`\x82"


def input_audio(data):
    """Validate a stereo 48 kHz signed 16-bit PCM WAV of 1-30 seconds; returns whole seconds (rounded up)."""
    if len(data) > MAX_AUDIO_BYTES:
        raise ValidationError("Input must be at most 8 MiB")
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (2, 2, 48000):
                raise ValidationError("Input must be stereo 48 kHz signed 16-bit PCM WAV")
            frames = audio.getnframes()
            if not 48000 <= frames <= 30 * 48000:
                raise ValidationError("Input must be 1-30 seconds")
            pcm = audio.readframes(frames)
    except (wave.Error, EOFError):
        raise ValidationError("Input must be a PCM WAV file") from None
    if len(pcm) != frames * 4:
        raise ValidationError("Truncated input PCM")
    if not any(pcm):
        raise ValidationError("Silent input cannot demonstrate hardware processing")
    return math.ceil(frames / 48000)


def normalize_capture(data):
    """The TV's 32-bit stereo capture, peak-normalised to 0.8 of full scale; returns (wav bytes, gain)."""
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (2, 4, 48000):
                raise RuntimeError("Unexpected hardware capture format")
            frames = audio.getnframes()
            pcm = audio.readframes(frames)
    except (wave.Error, EOFError):
        raise RuntimeError("Unexpected hardware capture format") from None
    if not frames or len(pcm) != frames * 8:
        raise RuntimeError("Empty or truncated hardware capture")
    peak = max(abs(value[0]) for value in struct.iter_unpack("<i", pcm))
    if not peak:
        raise RuntimeError("Sound-engine capture is silent; no processed output proven")
    # The safe TV volume is low; normalise only playback gain, not spectral content.
    gain = int((2**31 - 1) * 0.8) / peak
    normalized = bytearray(len(pcm))
    for offset, (sample,) in enumerate(struct.iter_unpack("<i", pcm)):
        struct.pack_into("<i", normalized, offset * 4, round(sample * gain))
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((2, 4, 48000, 0, "NONE", "not compressed"))
        audio.writeframes(normalized)
    return output.getvalue(), gain


def image_contract(stream):
    """ffprobe stream info -> (width, height); 8-bit PNG/JPEG, even 16:9 up to 1920x1080, no resizing."""
    formats = {"rgb24", "rgba", "pal8", "gray", "ya8", "gbrp",
               "yuv420p", "yuv422p", "yuv444p", "yuvj420p", "yuvj422p", "yuvj444p"}
    if stream.get("codec_name") not in ("png", "mjpeg") or stream.get("pix_fmt") not in formats:
        raise ValidationError("Images must be 8-bit PNG or JPEG")
    width, height = stream.get("width"), stream.get("height")
    if (type(width) is not int or type(height) is not int or not 32 <= width <= 1920
            or not 18 <= height <= 1080 or width % 2 or height % 2 or width * 9 != height * 16):
        raise ValidationError("Images need even 16:9 dimensions up to 1920x1080; no implicit resizing")
    return width, height


def save_output(data, destination):
    """Write `data` to `destination` without ever replacing an existing file (hard link, then unlink temp)."""
    destination = Path(destination)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
        os.link(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink()


def split_reply(out):
    """`<metadata JSON line>\\n<raw bytes>` -> (metadata dict, raw bytes)."""
    line, newline, raw = out.partition(b"\n")
    try:
        metadata = json.loads(line)
    except ValueError:
        metadata = None
    if not newline or not isinstance(metadata, dict):
        raise RuntimeError("TV returned a malformed processing reply")
    return metadata, raw


def _step(log, cancel, message):
    if cancel is not None and cancel.is_set():
        raise Cancelled("cancelled")
    if log is not None:
        log(message)


def _check_destination(output_path):
    destination = Path(output_path)
    if destination.exists():
        raise FileExistsError("Refusing to overwrite " + str(destination))
    return destination


def _confirmed(metadata, profile):
    if metadata.get("restored") is not True or metadata.get("profile") != profile:
        raise RuntimeError("TV did not confirm processing and restoration")


def _probe(source):
    try:
        probe = subprocess.run([
            "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,pix_fmt", "-of", "json", "-i", str(source),
        ], stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=15)
    except FileNotFoundError:
        raise RuntimeError("ffprobe is required for image processing but was not found on PATH") from None
    except subprocess.CalledProcessError:
        raise ValidationError("Not a readable PNG/JPEG image") from None
    streams = json.loads(probe.stdout).get("streams", [])
    if len(streams) != 1:
        raise ValidationError("Expected one still-image stream")
    return streams[0]


def _encode(source, video):
    try:
        # shortcut: H.264 8-bit 4:2:0 transport is lossy; use an RGB/10-bit path before judging photo fidelity.
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe",
            "-f", "image2", "-pattern_type", "none", "-loop", "1", "-framerate", "25", "-noautorotate",
            "-i", str(source), "-t", "30", "-an", "-c:v", "libx264", "-preset", "ultrafast",
            "-crf", "15", "-threads", "1", "-pix_fmt", "yuv420p", "-map_metadata", "-1",
            "-movflags", "+faststart", str(video),
        ], stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=60)
    except FileNotFoundError:
        raise RuntimeError("ffmpeg is required for image processing but was not found on PATH") from None
    except subprocess.CalledProcessError as error:
        raise RuntimeError("ffmpeg failed: " + error.stderr.decode(errors="replace")[-300:]) from None


def enhance_image(transport, input_path, output_path, profile=IMAGE_PROFILES[0], *, log=None, cancel=None) -> dict:
    """Write a 4K PNG from the TV's picture pipeline; temporarily displays the image on the TV.
    `log(str)` gets one line per step; `cancel` (threading.Event) is honoured between steps (an SSH call
    already running cannot be interrupted, so the TV finishes and restores itself first)."""
    if profile not in IMAGE_PROFILES:
        raise ValidationError("Unknown picture profile")
    source, destination = Path(input_path).resolve(), _check_destination(output_path)
    if not source.is_file() or source.suffix.lower() not in (".png", ".jpg", ".jpeg") \
            or source.stat().st_size > MAX_IMAGE_BYTES:
        raise ValidationError("Image must be a local PNG/JPEG file at most 16 MiB")
    _step(log, cancel, "checking the image")
    width, height = image_contract(_probe(source))
    with tempfile.TemporaryDirectory(prefix="wof-image-") as temporary:
        video = Path(temporary) / "input.mp4"
        _step(log, cancel, "encoding the image as video")
        _encode(source, video)
        data = video.read_bytes()
    _step(log, cancel, "processing on the TV (the TV shows the image for a few seconds)")
    metadata, result = split_reply(transport.run(dispatcher.build_process_image(profile, width, height),
                                                 data=data, timeout=65))
    _confirmed(metadata, profile)
    if (len(result) < 45 or result[:8] != PNG_MAGIC or struct.unpack(">II", result[16:24]) != (3840, 2160)
            or result[-12:] != PNG_END):
        raise RuntimeError("The TV did not return a 3840x2160 PNG")
    _step(log, cancel, "saving the result")
    save_output(result, destination)
    return {**metadata, "output": str(destination), "transport": "H264 8-bit YUV420p CRF15",
            "displayed_on_tv": True, "neural_subalgorithm_verified": False}


def enhance_audio(transport, input_path, output_path, profile=AUDIO_PROFILES[0], *, log=None, cancel=None) -> dict:
    """Write a WAV processed by the TV's sound engine; temporarily plays the input through the TV."""
    if profile not in AUDIO_PROFILES:
        raise ValidationError("Unknown sound profile")
    source, destination = Path(input_path), _check_destination(output_path)
    if source.stat().st_size > MAX_AUDIO_BYTES:
        raise ValidationError("Input must be at most 8 MiB")
    data = source.read_bytes()
    _step(log, cancel, "checking the audio")
    seconds = input_audio(data)
    _step(log, cancel, "processing on the TV (it plays the audio through its speakers)")
    metadata, raw = split_reply(transport.run(dispatcher.build_process_audio(profile, seconds),
                                              data=data, timeout=seconds + 65))
    _confirmed(metadata, profile)
    try:
        with wave.open(io.BytesIO(raw), "rb") as capture:
            frames = capture.getnframes()
    except (wave.Error, EOFError):
        raise RuntimeError("The TV did not return a WAV capture") from None
    if frames != (seconds + 2) * 48000:
        raise RuntimeError("Incomplete hardware audio capture")
    result, gain = normalize_capture(raw)
    _step(log, cancel, "saving the result")
    save_output(result, destination)
    return {**metadata, "output": str(destination), "peak_normalization_gain": gain,
            "peak_normalized_to": 0.8, "neural_subalgorithm_verified": False}


def wait_for_idle(transport) -> None:
    """Block until no job holds the TV lock (raises TvBusyError if it is still held after ~25 s)."""
    transport.run(dispatcher.build_idle_wait(), timeout=30)
