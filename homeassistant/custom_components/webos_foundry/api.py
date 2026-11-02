"""Thin async client for the webOS Foundry HTTP API (``wof serve``).

Deliberately free of Home Assistant imports so it can be tested on its own.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import quote

import aiohttp

READ_TIMEOUT = 20
# Writes wait for the TV's own confirmation (say, remote, settings readback).
WRITE_TIMEOUT = 60


class WebosFoundryApiError(Exception):
    """The server answered non-2xx; ``str(err)`` is its ``{"error": ...}`` message."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class WebosFoundryAuthError(WebosFoundryApiError):
    """HTTP 401: missing or wrong bearer token."""


class WebosFoundryConnectionError(WebosFoundryApiError):
    """The server could not be reached (refused, DNS, timeout)."""


class WebosFoundryApi:
    def __init__(self, session: aiohttp.ClientSession, host: str, port: int, token: str) -> None:
        bracketed = f"[{host}]" if ":" in host and not host.startswith("[") else host
        self._base = f"http://{bracketed}:{port}"
        self._session = session
        self._token = token

    async def _request(
        self, method: str, path: str, body: Any = None, *, auth: bool = True, timeout: float = READ_TIMEOUT
    ) -> Any:
        headers = {"Authorization": f"Bearer {self._token}"} if auth else {}
        try:
            async with self._session.request(
                method,
                self._base + path,
                json=body,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                text = await resp.text()
                status = resp.status
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise WebosFoundryConnectionError(f"Cannot reach {self._base}: {str(err) or type(err).__name__}") from err
        try:
            data = json.loads(text) if text else None
        except ValueError:
            data = None
        if 200 <= status < 300:
            return data
        message = data.get("error") if isinstance(data, dict) else None
        message = message or text[:200] or f"HTTP {status}"
        raise (WebosFoundryAuthError if status == 401 else WebosFoundryApiError)(message, status)

    async def get_health(self) -> dict:
        """``{"paired": bool, "tv_host": str|null}``; needs no token."""
        return await self._request("GET", "/api/health", auth=False)

    async def get_status(self) -> dict:
        return await self._request("GET", "/api/status")

    async def get_details(self) -> dict:
        return await self._request("GET", "/api/details")

    async def get_settings(self) -> list[dict]:
        return await self._request("GET", "/api/settings")

    async def set_setting(self, category: str, key: str, value: Any, context: dict) -> dict:
        path = f"/api/settings/{quote(category, safe='')}/{quote(key, safe='')}"
        return await self._request("PUT", path, {"value": value, "context": context}, timeout=WRITE_TIMEOUT)

    async def remote(self, action: str, value: Any = None) -> dict:
        body = None if value is None else {"value": value}
        return await self._request("POST", f"/api/remote/{quote(action, safe='')}", body, timeout=WRITE_TIMEOUT)

    async def notify_toast(self, message: str) -> dict:
        return await self._request("POST", "/api/notify/toast", {"message": message}, timeout=WRITE_TIMEOUT)

    async def notify_say(self, message: str, volume: int | None = None) -> dict:
        body: dict[str, Any] = {"message": message}
        if volume is not None:
            body["volume"] = volume
        return await self._request("POST", "/api/notify/say", body, timeout=WRITE_TIMEOUT)

    async def overlay_show(self, card: dict) -> dict:
        return await self._request("POST", "/api/overlay", card, timeout=WRITE_TIMEOUT)

    async def overlay_hide(self) -> dict:
        return await self._request("POST", "/api/overlay", {"hide": True}, timeout=WRITE_TIMEOUT)
