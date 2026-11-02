"""Config flow: host, port and bearer token of a running `wof serve`."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import (
    WebosFoundryApi,
    WebosFoundryApiError,
    WebosFoundryAuthError,
    WebosFoundryConnectionError,
)
from .const import CONF_TOKEN, DEFAULT_PORT, DOMAIN


async def _validate(hass, host: str, port: int, token: str) -> str | None:
    """Return a strings.json error key, or None when the server and token work."""
    api = WebosFoundryApi(async_get_clientsession(hass), host, port, token)
    try:
        if not (await api.get_health()).get("paired"):
            return "not_paired"
        await api.get_status()
    except WebosFoundryAuthError:
        return "invalid_auth"
    except WebosFoundryConnectionError:
        return "cannot_connect"
    except WebosFoundryApiError:
        return "tv_error"
    return None


class WebosFoundryConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        errors: dict[str, str] = {}
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            port = user_input[CONF_PORT]
            await self.async_set_unique_id(f"{host}:{port}".lower())
            self._abort_if_unique_id_configured()
            error = await _validate(self.hass, host, port, user_input[CONF_TOKEN])
            if error is None:
                return self.async_create_entry(
                    title=f"webOS Foundry ({host})",
                    data={CONF_HOST: host, CONF_PORT: port, CONF_TOKEN: user_input[CONF_TOKEN]},
                )
            errors["base"] = error
        user_input = user_input or {}
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST, default=user_input.get(CONF_HOST, "")): str,
                    vol.Required(CONF_PORT, default=user_input.get(CONF_PORT, DEFAULT_PORT)): vol.All(
                        vol.Coerce(int), vol.Range(min=1, max=65535)
                    ),
                    vol.Required(CONF_TOKEN): str,
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: dict[str, Any]):
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None):
        entry = self.hass.config_entries.async_get_entry(self.context["entry_id"])
        errors: dict[str, str] = {}
        if user_input is not None:
            error = await _validate(self.hass, entry.data[CONF_HOST], entry.data[CONF_PORT], user_input[CONF_TOKEN])
            if error is None:
                self.hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_TOKEN: user_input[CONF_TOKEN]})
                await self.hass.config_entries.async_reload(entry.entry_id)
                return self.async_abort(reason="reauth_successful")
            errors["base"] = error
        return self.async_show_form(
            step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_TOKEN): str}), errors=errors
        )
