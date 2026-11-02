"""webos_foundry.* services; each calls the matching HTTP API route."""
from __future__ import annotations

from collections.abc import Awaitable, Callable

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .api import WebosFoundryApi, WebosFoundryApiError
from .const import DOMAIN

ENTRY = {vol.Optional("config_entry_id"): cv.string}
CARD_FIELDS = ("title", "body", "lines", "image")

TOAST = vol.Schema({**ENTRY, vol.Required("message"): cv.string})
SAY = vol.Schema({**ENTRY, vol.Required("message"): cv.string, vol.Optional("volume"): vol.All(vol.Coerce(int), vol.Range(min=1, max=40))})
OVERLAY_SHOW = vol.All(
    vol.Schema(
        {
            **ENTRY,
            vol.Optional("title"): cv.string,
            vol.Optional("body"): cv.string,
            vol.Optional("lines"): vol.All(cv.ensure_list, [cv.string]),
            vol.Optional("image"): cv.string,
            vol.Optional("kind"): vol.In(["info", "success", "warning", "alert"]),
            vol.Optional("position"): vol.In(["top-left", "top-right", "bottom-left", "bottom-right", "center"]),
            vol.Optional("seconds"): vol.All(vol.Coerce(int), vol.Range(min=0, max=300)),
        }
    ),
    cv.has_at_least_one_key(*CARD_FIELDS),
)
OVERLAY_HIDE = vol.Schema(ENTRY)
REMOTE = vol.Schema({**ENTRY, vol.Required("action"): cv.string, vol.Optional("value"): vol.Coerce(int)})
SET_SETTING = vol.Schema(
    {**ENTRY, vol.Required("category"): cv.string, vol.Required("key"): cv.string, vol.Required("value"): cv.match_all}
)


def _target(hass: HomeAssistant, call: ServiceCall) -> dict:
    """The entry's data dict ({api, status, details}): the given one, or the only configured one."""
    entries = hass.data.get(DOMAIN, {})
    entry_id = call.data.get("config_entry_id")
    if entry_id is None:
        if len(entries) != 1:
            raise ServiceValidationError("More than one webOS Foundry TV is configured: pass config_entry_id")
        return next(iter(entries.values()))
    if entry_id not in entries:
        raise ServiceValidationError(f"Unknown webOS Foundry config_entry_id {entry_id}")
    return entries[entry_id]


def _action(hass: HomeAssistant, fn: Callable[[WebosFoundryApi, dict], Awaitable], refresh: bool = False):
    async def handler(call: ServiceCall) -> None:
        target = _target(hass, call)
        try:
            await fn(target["api"], dict(call.data))
        except WebosFoundryApiError as err:
            raise HomeAssistantError(str(err)) from err
        if refresh:
            await target["status"].async_request_refresh()

    return handler


async def _set_setting(api: WebosFoundryApi, data: dict) -> None:
    # The context (input/mode scope) must come from the TV's current listing, like the TV-side scope check expects.
    for setting in await api.get_settings():
        if setting["category"] == data["category"] and setting["key"] == data["key"]:
            await api.set_setting(data["category"], data["key"], data["value"], setting["context"])
            return
    raise ServiceValidationError(f"Unknown setting {data['category']}.{data['key']}; GET /api/settings lists them")


async def _overlay_show(api: WebosFoundryApi, data: dict) -> None:
    await api.overlay_show({k: v for k, v in data.items() if k != "config_entry_id"})


def async_register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, "toast"):
        return
    for name, schema, fn, refresh in (
        ("toast", TOAST, lambda api, d: api.notify_toast(d["message"]), False),
        ("say", SAY, lambda api, d: api.notify_say(d["message"], d.get("volume")), False),
        ("overlay_show", OVERLAY_SHOW, _overlay_show, False),
        ("overlay_hide", OVERLAY_HIDE, lambda api, d: api.overlay_hide(), False),
        ("remote", REMOTE, lambda api, d: api.remote(d["action"], d.get("value")), True),
        ("set_setting", SET_SETTING, _set_setting, False),
    ):
        hass.services.async_register(DOMAIN, name, _action(hass, fn, refresh), schema=schema)


def async_remove_services(hass: HomeAssistant) -> None:
    for name in ("toast", "say", "overlay_show", "overlay_hide", "remote", "set_setting"):
        hass.services.async_remove(DOMAIN, name)
