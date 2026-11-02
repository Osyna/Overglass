"""Wake button: a Wake-on-LAN broadcast sent by the `wof serve` host (needs `mac` in its config)."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import WebosFoundryApiError
from .const import DOMAIN
from .entity import device_info


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([WebosFoundryWakeButton(hass.data[DOMAIN][entry.entry_id], entry)])


class WebosFoundryWakeButton(ButtonEntity):
    _attr_has_entity_name = True
    _attr_name = "Wake"

    def __init__(self, data: dict, entry: ConfigEntry) -> None:
        self._data = data
        self._attr_unique_id = f"{entry.entry_id}_wake"
        self._attr_device_info = device_info(entry)

    async def async_press(self) -> None:
        try:
            await self._data["api"].remote("wake")
        except WebosFoundryApiError as err:
            raise HomeAssistantError(str(err)) from err
        await self._data["status"].async_request_refresh()
