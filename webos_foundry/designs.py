"""Named validated overlay cards, bounded revisions and portable sharing bundles."""
import base64
import binascii
import copy
import json
import os
import re
import secrets
import tempfile
import threading
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from . import notify
from .config import config_dir
from .errors import ValidationError

FILE = "designs.json"
HISTORY_FILE = "design-history.json"
NAME_MAX = 60
LOCK = threading.RLock()
_SECRET = re.compile(r"token|auth|password|passwd|secret|credential|signature|(?:^|[_-])(?:api[_-]?)?key(?:$|[_-])", re.I)


def check_name(name):
    if not isinstance(name, str) or not (1 <= len(name) <= NAME_MAX) or name.strip() != name:
        raise ValidationError("A design name must be 1-%d characters with no leading/trailing space" % NAME_MAX)
    return name


def check_design(body) -> dict:
    from . import bindings
    if not isinstance(body, dict):
        raise ValidationError("The design must be a JSON object")
    plain = dict(body)
    entries = plain.pop("bindings", None)
    card = notify.check_overlay_request(plain)
    if card.get("hide") or card.get("action"):
        raise ValidationError("A design must contain a card, not a hide request or runtime command")
    if entries is not None:
        card["bindings"] = bindings.check(card, entries)
    elif "bindings" in body:
        raise ValidationError("bindings must be a list")
    return card


def _read_file(filename, config_dir_override=None):
    try:
        return json.loads((config_dir(config_dir_override) / filename).read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise ValidationError("%s is unreadable: %s" % (filename, error)) from None


def load(config_dir_override=None) -> dict:
    with LOCK:
        doc = _read_file(FILE, config_dir_override)
        if not isinstance(doc, dict):
            raise ValidationError("designs.json is malformed")
        try:
            return {check_name(name): check_design(card) for name, card in doc.items()}
        except ValidationError as error:
            raise ValidationError("designs.json is malformed: %s" % error) from None


def _commit(documents, config_dir_override):
    """Stage every file first; failed replacements restore the original byte-for-byte stores."""
    directory = config_dir(config_dir_override)
    directory.mkdir(parents=True, exist_ok=True)
    staged, backups, applied = {}, {}, []

    def stage(content):
        descriptor, name = tempfile.mkstemp(prefix=".designs-", dir=directory)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
        except BaseException:
            os.unlink(name)
            raise
        return name

    try:
        for filename, document in documents.items():
            path = directory / filename
            staged[filename] = stage((json.dumps(document, indent=2, allow_nan=False) + "\n").encode())
            backups[filename] = stage(path.read_bytes()) if path.exists() else None
        for filename, temp_name in staged.items():
            os.replace(temp_name, directory / filename)
            applied.append(filename)
    except BaseException:
        for filename in reversed(applied):
            if backups[filename] is None:
                os.unlink(directory / filename)
            else:
                backup = backups[filename]
                backups[filename] = None  # Keep the recovery copy if even rollback cannot write.
                os.rename(backup, directory / filename)
        raise
    finally:
        for name in list(staged.values()) + list(backups.values()):
            if name is not None:
                try:
                    os.unlink(name)
                except FileNotFoundError:
                    pass


def _write(designs, config_dir_override):
    _commit({FILE: designs}, config_dir_override)


def _histories(config_dir_override):
    doc = _read_file(HISTORY_FILE, config_dir_override)
    if not isinstance(doc, dict):
        raise ValidationError("design-history.json is malformed")
    for name, versions in doc.items():
        check_name(name)
        if not isinstance(versions, list) or len(versions) > 100:
            raise ValidationError("design-history.json is malformed")
        ids = set()
        for version in versions:
            if not isinstance(version, dict) or set(version) != {"id", "created_at", "card"} or not isinstance(version["id"], str) or not version["id"] or version["id"] in ids or not isinstance(version["created_at"], str):
                raise ValidationError("design-history.json is malformed")
            check_design(version["card"])
            ids.add(version["id"])
    return doc


def _record(histories, name, card):
    versions = histories.setdefault(name, [])
    revision_id = secrets.token_hex(16)
    while any(version["id"] == revision_id for items in histories.values() for version in items):
        revision_id = secrets.token_hex(16)
    versions.append({"id": revision_id, "created_at": datetime.now(timezone.utc).isoformat(), "card": copy.deepcopy(card)})
    histories[name] = versions[-100:]


def save(name, body, config_dir_override=None) -> dict:
    name, card = check_name(name), check_design(body)
    with LOCK:
        saved, histories = load(config_dir_override), _histories(config_dir_override)
        if name in saved:
            _record(histories, name, saved[name])
        saved[name] = card
        _commit({HISTORY_FILE: histories, FILE: saved}, config_dir_override)
    return card


def history(name, config_dir_override=None):
    with LOCK:
        if name not in load(config_dir_override):
            raise ValidationError("No such design: %s" % name)
        return copy.deepcopy(_histories(config_dir_override).get(name, []))


def restore(name, revision_id, config_dir_override=None):
    with LOCK:
        versions = history(name, config_dir_override)
        revision = next((version for version in versions if version["id"] == revision_id), None)
        if revision is None:
            raise ValidationError("No such design revision")
        return save(name, revision["card"], config_dir_override)


def rename(name, new_name, config_dir_override=None):
    check_name(new_name)
    with LOCK:
        saved, histories = load(config_dir_override), _histories(config_dir_override)
        if name not in saved:
            raise ValidationError("No such design: %s" % name)
        if new_name in saved or new_name in histories:
            raise ValidationError("A design or revision history already uses that name")
        saved[new_name] = saved.pop(name)
        if name in histories:
            histories[new_name] = histories.pop(name)
        _commit({HISTORY_FILE: histories, FILE: saved}, config_dir_override)
        return saved[new_name]


def delete(name, config_dir_override=None):
    with LOCK:
        saved = load(config_dir_override)
        if name not in saved:
            raise ValidationError("No such design: %s" % name)
        del saved[name]
        _write(saved, config_dir_override)


def show(transport, name, config_dir_override=None) -> str:
    from . import bindings
    saved = load(config_dir_override)
    if name not in saved:
        raise ValidationError("No such design: %s" % name)
    return notify.overlay_show(transport, bindings.resolve(saved[name]))


def _thumbnail(value):
    if not isinstance(value, str):
        raise ValidationError("A thumbnail must be sanitized SVG or a PNG data URL")
    if value.startswith("data:image/png;base64,"):
        if len(value) > 350000:
            raise ValidationError("PNG thumbnail is too large")
        try:
            data = base64.b64decode(value.split(",", 1)[1], validate=True)
        except (ValueError, binascii.Error):
            raise ValidationError("Invalid PNG thumbnail") from None
        if len(data) > 262144 or len(data) < 33 or data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
            raise ValidationError("Invalid PNG thumbnail")
        width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        if not 1 <= width <= 4096 or not 1 <= height <= 4096 or width * height > 4194304:
            raise ValidationError("PNG thumbnail dimensions are too large")
        offset, chunks, image_data, ended = 8, [], False, False
        while offset < len(data):
            if offset + 12 > len(data):
                raise ValidationError("Invalid PNG thumbnail chunks")
            length = int.from_bytes(data[offset:offset + 4], "big")
            end = offset + 12 + length
            if end > len(data):
                raise ValidationError("Invalid PNG thumbnail chunk length")
            kind, payload = data[offset + 4:offset + 8], data[offset + 8:end - 4]
            if binascii.crc32(kind + payload) != int.from_bytes(data[end - 4:end], "big"):
                raise ValidationError("Invalid PNG thumbnail checksum")
            if not chunks and kind != b"IHDR":
                raise ValidationError("Invalid PNG thumbnail header")
            if kind in (b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"):
                if kind == b"IHDR" and chunks:
                    raise ValidationError("Duplicate PNG thumbnail header")
                chunks.append(data[offset:end])
            elif not kind[0] & 32:
                raise ValidationError("Unsupported PNG thumbnail chunk")
            image_data = image_data or kind == b"IDAT"
            offset = end
            if kind == b"IEND":
                if length or offset != len(data):
                    raise ValidationError("Invalid PNG thumbnail end")
                ended = True
                break
        if not image_data or not ended:
            raise ValidationError("Incomplete PNG thumbnail")
        return "data:image/png;base64," + base64.b64encode(data[:8] + b"".join(chunks)).decode()
    return notify._check_svg(value)


def _redact(card):
    required = []
    entries = card.get("bindings", [])
    if not isinstance(entries, list):
        raise ValidationError("bindings must be a list")
    for index, binding in enumerate(entries):
        if not isinstance(binding, dict) or not isinstance(binding.get("source"), dict):
            raise ValidationError("Invalid binding source")
        source = binding["source"]
        markers = source.get("required_secrets", [])
        if not isinstance(markers, list) or any(item not in ("token", "url") for item in markers):
            raise ValidationError("Invalid required_secrets marker")
        missing = set(markers)
        if "token" in source:
            del source["token"]
            missing.add("token")
        if missing:
            source["required_secrets"] = sorted(missing)
        for field in missing:
            required.append("/bindings/%d/source/%s" % (index, field))

    def clean(value, pointer=""):
        if isinstance(value, dict):
            for key in list(value):
                if not isinstance(key, str):
                    raise ValidationError("Design object keys must be text")
                if _SECRET.search(key) and key != "required_secrets":
                    del value[key]
                    required.append(pointer + "/" + key)
                else:
                    value[key] = clean(value[key], pointer + "/" + key)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                value[index] = clean(item, pointer + "/" + str(index))
        elif isinstance(value, str) and value.lower().startswith(("https://", "http://")):
            try:
                parsed = urlsplit(value)
            except ValueError:
                raise ValidationError("Invalid design URL") from None
            pairs = parse_qsl(parsed.query, keep_blank_values=True)
            filtered = [(key, item) for key, item in pairs if not _SECRET.search(key)]
            if parsed.username or parsed.password or filtered != pairs:
                host = parsed.netloc.rsplit("@", 1)[-1]
                value = urlunsplit((parsed.scheme, host, parsed.path, urlencode(filtered), ""))
                required.append(pointer)
                match = re.fullmatch(r"/bindings/(\d+)/source/url", pointer)
                if match:
                    source = card["bindings"][int(match.group(1))]["source"]
                    source["required_secrets"] = sorted(set(source.get("required_secrets", []) + ["url"]))
        return value

    clean(card)
    return sorted(set(required))


def export_bundle(name, config_dir_override=None, thumbnail=None):
    saved = load(config_dir_override)
    if name not in saved:
        raise ValidationError("No such design: %s" % name)
    card = copy.deepcopy(saved[name])
    required = _redact(card)
    bundle = {"format": "webos-foundry-design", "version": 1, "name": name, "card": card}
    if required:
        bundle["required_secrets"] = required
    if thumbnail is not None:
        bundle["thumbnail"] = _thumbnail(thumbnail)
    return bundle


def import_bundle(body, config_dir_override=None, name=None, overwrite=False):
    if not isinstance(body, dict) or set(body) - {"format", "version", "name", "card", "thumbnail", "required_secrets"} or body.get("format") != "webos-foundry-design" or type(body.get("version")) is not int or body["version"] != 1:
        raise ValidationError("Expected a version 1 webos-foundry-design bundle")
    if type(overwrite) is not bool:
        raise ValidationError("overwrite must be a boolean")
    target = check_name(body.get("name") if name is None else name)
    if "thumbnail" in body:
        _thumbnail(body["thumbnail"])
    required = body.get("required_secrets", [])
    if not isinstance(required, list) or any(not isinstance(item, str) or len(item) > 500 for item in required):
        raise ValidationError("Invalid required_secrets list")
    try:
        serialized = json.dumps(body.get("card"), allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        raise ValidationError("Bundle card must be finite JSON") from None
    if len(serialized.encode()) > 262144:
        raise ValidationError("Bundle card is too large")
    try:
        card = copy.deepcopy(body.get("card"))
    except RecursionError:
        raise ValidationError("Bundle card is too deeply nested") from None
    if not isinstance(card, dict):
        raise ValidationError("Bundle card must be an object")
    for pointer in required:
        match = re.fullmatch(r"/bindings/(\d+)/source/(token|url)", pointer)
        if match:
            index, field = int(match.group(1)), match.group(2)
            entries = card.get("bindings", [])
            if not isinstance(entries, list) or index >= len(entries) or not isinstance(entries[index], dict) or not isinstance(entries[index].get("source"), dict):
                raise ValidationError("A required secret points to a missing binding")
            source = entries[index]["source"]
            markers = source.get("required_secrets", [])
            if not isinstance(markers, list) or any(item not in ("token", "url") for item in markers):
                raise ValidationError("Invalid required_secrets marker")
            source["required_secrets"] = sorted(set(markers + [field]))
    _redact(card)
    card = check_design(card)
    with LOCK:
        if target in load(config_dir_override) and not overwrite:
            raise ValidationError("A design with that name already exists; choose another name or explicitly overwrite")
        return save(target, card, config_dir_override)
