"""webOS Foundry: Home Assistant integration over the `wof serve` HTTP API."""
from __future__ import annotations

from datetime import timedelta
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import WebosFoundryApi, WebosFoundryApiError, WebosFoundryAuthError
from .const import CONF_TOKEN, DETAILS_INTERVAL, DOMAIN, PLATFORMS, STATUS_INTERVAL
from .services import async_register_services, async_remove_services

_LOGGER = logging.getLogger(__name__)


def _coordinator(hass: HomeAssistant, name: str, fetch, seconds: int) -> DataUpdateCoordinator:
    async def update():
        try:
            return await fetch()
        except WebosFoundryAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except WebosFoundryApiError as err:
            raise UpdateFailed(str(err)) from err

    return DataUpdateCoordinator(
        hass, _LOGGER, name=f"{DOMAIN} {name}", update_method=update, update_interval=timedelta(seconds=seconds)
    )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    api = WebosFoundryApi(
        async_get_clientsession(hass), entry.data[CONF_HOST], entry.data[CONF_PORT], entry.data[CONF_TOKEN]
    )
    status = _coordinator(hass, "status", api.get_status, STATUS_INTERVAL)
    details = _coordinator(hass, "details", api.get_details, DETAILS_INTERVAL)
    # Status must work for setup to succeed; details can fail while the TV is in standby,
    # so its first refresh only marks the details sensors unavailable instead of blocking setup.
    await status.async_config_entry_first_refresh()
    await details.async_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {"api": api, "status": status, "details": details}
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    async_register_services(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    hass.data[DOMAIN].pop(entry.entry_id)
    if not hass.data[DOMAIN]:
        async_remove_services(hass)
    return True
