"""Binary sensors from /api/status: powered, is_luma."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .entity import WebosFoundryEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    status = hass.data[DOMAIN][entry.entry_id]["status"]
    async_add_entities(
        [
            WebosFoundryBinarySensor(status, entry, "powered", "Powered", BinarySensorDeviceClass.POWER),
            WebosFoundryBinarySensor(status, entry, "is_luma", "Luma in front", None),
        ]
    )


class WebosFoundryBinarySensor(WebosFoundryEntity, BinarySensorEntity):
    def __init__(self, coordinator, entry: ConfigEntry, key: str, name: str, device_class) -> None:
        super().__init__(coordinator, entry, key)
        self._key = key
        self._attr_name = name
        self._attr_device_class = device_class

    @property
    def is_on(self) -> bool | None:
        data = self.coordinator.data
        if self._key == "powered":
            # status reports "unknown" while the TV state cannot be read
            return {"on": True, "off": False}.get(data.get("power"))
        return data.get("is_luma")
