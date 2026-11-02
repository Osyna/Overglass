"""Bounded HTTP(S) reads for connectors and design bindings.

Public destinations only unless allow_private=True is explicitly supplied. Every
redirect is resolved and checked again; sockets connect to the checked IP, while
HTTPS still verifies the original hostname. Environment proxies are never used.
Caller headers are removed on cross-origin redirects. Errors never include URLs,
response bodies or credentials. Responses are uncompressed and limited to 1 MiB;
the eight-second deadline covers DNS, connections, redirects and body reads.
"""
import concurrent.futures
import http.client
import ipaddress
import json
import math
import re
import socket
import ssl
import threading
import time
from urllib.parse import urljoin, urlsplit

from .errors import ValidationError

TIMEOUT = 8
MAX_BYTES = 1024 * 1024
MAX_REDIRECTS = 4
_DNS = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="data-dns")
_DNS_SLOTS = threading.BoundedSemaphore(4)
_BAD_KEYS = {"__proto__", "prototype", "constructor"}


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError("Data request timed out")
    return remaining


def _url(url):
    if not isinstance(url, str) or not 1 <= len(url) <= 4096 or re.search(r"[\s\\\x00-\x1f\x7f]", url):
        raise ValidationError("Data URL must be an HTTP(S) URL without whitespace")
    try:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None or parts.password is not None:
            raise ValueError
        host = parts.hostname.encode("idna").decode("ascii")
        port = parts.port if parts.port is not None else (443 if parts.scheme == "https" else 80)
        if not 1 <= port <= 65535 or "%" in host:
            raise ValueError
    except (ValueError, UnicodeError):
        raise ValidationError("Data URL must be HTTP(S), with a host and no embedded credentials") from None
    return parts, host, port


def _addresses(host, port, allow_private, deadline):
    if not _DNS_SLOTS.acquire(timeout=_remaining(deadline)):
        raise RuntimeError("Data DNS lookup timed out")
    try:
        future = _DNS.submit(socket.getaddrinfo, host, port, 0, socket.SOCK_STREAM)
    except BaseException:
        _DNS_SLOTS.release()
        raise
    future.add_done_callback(lambda _: _DNS_SLOTS.release())
    try:
        addresses = future.result(timeout=_remaining(deadline))
    except concurrent.futures.TimeoutError:
        raise RuntimeError("Data DNS lookup timed out") from None
    if not addresses:
        raise RuntimeError("Data host has no addresses")
    for _, _, _, _, sockaddr in addresses:
        address = ipaddress.ip_address(sockaddr[0])
        mapped = getattr(address, "ipv4_mapped", None)
        address = mapped or address
        translated = isinstance(address, ipaddress.IPv6Address) and (
            address in ipaddress.ip_network("64:ff9b::/96") or
            address in ipaddress.ip_network("64:ff9b:1::/48") or
            address.sixtofour is not None or address.teredo is not None)
        if address.is_unspecified or address.is_multicast or (not allow_private and (not address.is_global or address.is_reserved or translated)):
            raise ValidationError("Data host is not public; private network access requires explicit opt-in")
    return addresses


def _connection(parts, host, port, address, deadline):
    family, socktype, proto, _, sockaddr = address
    connection = http.client.HTTPConnection(host, port, timeout=_remaining(deadline))
    active = []

    def abort():
        if active:
            try:
                active[0].shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            active[0].close()

    def connect():
        sock = socket.socket(family, socktype, proto)
        active[:] = [sock]
        connection._deadline_timer = threading.Timer(_remaining(deadline), abort)
        connection._deadline_timer.daemon = True
        connection._deadline_timer.start()
        try:
            sock.settimeout(_remaining(deadline))
            sock.connect(sockaddr)
            if parts.scheme == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host, do_handshake_on_connect=False)
                active[:] = [sock]
                sock.settimeout(_remaining(deadline))
                sock.do_handshake()
            connection.sock = sock
        except BaseException:
            abort()
            raise

    connection.connect = connect
    return connection


def _headers(headers):
    if headers is None:
        return {}
    if not isinstance(headers, dict):
        raise ValidationError("Data headers must be an object")
    result = {}
    forbidden = {"host", "connection", "content-length", "transfer-encoding", "accept-encoding", "proxy-authorization", "proxy-connection", "upgrade", "trailer", "te"}
    for name, value in headers.items():
        if not isinstance(name, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or name.lower() in forbidden:
            raise ValidationError("Unsupported data request header")
        if not isinstance(value, str) or re.search(r"[\x00-\x1f\x7f]", value):
            raise ValidationError("Invalid data request header value")
        try:
            value.encode("latin-1")
        except UnicodeError:
            raise ValidationError("Invalid data request header value") from None
        result[name] = value
    return result


def fetch_text(url, headers=None, allow_private=False):
    """GET UTF-8 text; private access is opt-in, including after redirects."""
    if type(allow_private) is not bool:
        raise ValidationError("allow_private must be a boolean")
    headers = _headers(headers)
    deadline = time.monotonic() + TIMEOUT
    try:
        for redirect in range(MAX_REDIRECTS + 1):
            parts, host, port = _url(url)
            addresses = _addresses(host, port, allow_private, deadline)
            connection = _connection(parts, host, port, addresses[0], deadline)
            response = None
            try:
                target = parts.path or "/"
                if parts.query:
                    target += "?" + parts.query
                connection.request("GET", target, headers={"Accept-Encoding": "identity", "User-Agent": "webos-foundry/1", **headers})
                request_socket = connection.sock
                request_socket.settimeout(_remaining(deadline))
                response = connection.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if not location or redirect == MAX_REDIRECTS:
                        raise RuntimeError("Data redirect limit exceeded or missing destination")
                    destination = urljoin(url, location)
                    next_parts, next_host, next_port = _url(destination)
                    if (parts.scheme, host, port) != (next_parts.scheme, next_host, next_port):
                        headers = {}
                    url = destination
                    continue
                if not 200 <= response.status < 300:
                    raise RuntimeError("Data endpoint returned HTTP %d" % response.status)
                if response.getheader("Content-Encoding", "identity").lower() not in ("identity", ""):
                    raise RuntimeError("Compressed data responses are unsupported")
                length = response.getheader("Content-Length")
                if length is not None and (not length.isdigit() or int(length) > MAX_BYTES):
                    raise RuntimeError("Data response exceeds the size limit or has an invalid length")
                chunks, total = [], 0
                while not response.isclosed():
                    # read1 returns after one socket read, so a trickling peer cannot reset the deadline indefinitely.
                    request_socket.settimeout(_remaining(deadline))
                    chunk = response.read1(min(65536, MAX_BYTES + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise RuntimeError("Data response exceeds the size limit")
                    chunks.append(chunk)
                if length is not None and total != int(length):
                    raise RuntimeError("Data response ended before its declared length")
                return b"".join(chunks).decode("utf-8-sig")
            finally:
                if response is not None:
                    response.close()
                timer = getattr(connection, "_deadline_timer", None)
                if timer is not None:
                    timer.cancel()
                connection.close()
    except (ValidationError, RuntimeError):
        raise
    except (OSError, http.client.HTTPException, UnicodeError, ValueError):
        raise RuntimeError("Could not fetch data endpoint (network, TLS or response error)") from None


def fetch_json(url, headers=None, allow_private=False):
    """GET bounded JSON; reject non-standard NaN/Infinity values."""
    text = fetch_text(url, headers=headers, allow_private=allow_private)
    try:
        return json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, RecursionError):
        raise RuntimeError("Data endpoint returned malformed JSON") from None


def scalar_at(data, path=""):
    """Select a scalar via a dot path or RFC 6901 JSON pointer, never an object.

    Empty path selects the root. Array indexes are supported; prototype-related
    path segments and malformed pointer escapes are rejected even for JSON dicts.
    """
    if not isinstance(path, str) or len(path) > 500:
        raise ValidationError("Data path must be at most 500 characters")
    if path.startswith("/"):
        if re.search(r"~(?![01])", path):
            raise ValidationError("Malformed JSON pointer")
        keys = [key.replace("~1", "/").replace("~0", "~") for key in path[1:].split("/")]
    else:
        keys = path.split(".") if path else []
    try:
        for key in keys:
            if key in _BAD_KEYS:
                raise ValidationError("Unsafe data path")
            if isinstance(data, list):
                if not re.fullmatch(r"0|[1-9][0-9]*", key):
                    raise KeyError(key)
                data = data[int(key)]
            elif isinstance(data, dict):
                data = data[key]
            else:
                raise KeyError(key)
    except (KeyError, IndexError, ValueError):
        raise ValidationError("Data path was not found") from None
    if not (data is None or type(data) in (str, bool, int, float)) or (isinstance(data, float) and not math.isfinite(data)):
        raise ValidationError("Data path must select a finite JSON scalar")
    return data
