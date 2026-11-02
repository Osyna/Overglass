"""Sensors: /api/status (15 s) and /api/details (60 s)."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import LIGHT_LUX, PERCENTAGE, EntityCategory, UnitOfTemperature, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .entity import WebosFoundryEntity


def _get(key: str) -> Callable[[dict], Any]:
    return lambda data: data.get(key)


def _top_app(data: dict) -> str | None:
    apps = data.get("usage_today") or []
    return max(apps, key=lambda a: a.get("seconds") or 0)["app_id"] if apps else None


@dataclass(frozen=True, kw_only=True)
class WebosFoundrySensorDescription(SensorEntityDescription):
    coordinator: str  # "status" or "details" key of hass.data[DOMAIN][entry_id]
    value_fn: Callable[[dict], Any]
    attrs_fn: Callable[[dict], dict] | None = None


SENSORS = (
    WebosFoundrySensorDescription(key="power_state", name="Power state", coordinator="status", value_fn=_get("power"),
                                  attrs_fn=lambda d: {"raw_power_state": d.get("raw_power_state")}),
    WebosFoundrySensorDescription(key="source", name="Source", coordinator="status", value_fn=_get("source"),
                                  attrs_fn=lambda d: {"app_id": d.get("app_id")}),
    WebosFoundrySensorDescription(key="temperature", name="Temperature", coordinator="status",
                                  value_fn=_get("temperature_c"), device_class=SensorDeviceClass.TEMPERATURE,
                                  native_unit_of_measurement=UnitOfTemperature.CELSIUS,
                                  state_class=SensorStateClass.MEASUREMENT,
                                  attrs_fn=lambda d: {"temperature_source": d.get("temperature_source")}),
    WebosFoundrySensorDescription(key="volume", name="Volume", coordinator="status", value_fn=_get("volume"),
                                  native_unit_of_measurement=PERCENTAGE, state_class=SensorStateClass.MEASUREMENT,
                                  attrs_fn=lambda d: {"muted": d.get("muted")}),
    WebosFoundrySensorDescription(key="lux", name="Ambient light", coordinator="details", value_fn=_get("lux"),
                                  device_class=SensorDeviceClass.ILLUMINANCE, native_unit_of_measurement=LIGHT_LUX,
                                  state_class=SensorStateClass.MEASUREMENT),
    WebosFoundrySensorDescription(key="panel_hours", name="Panel hours", coordinator="details",
                                  value_fn=_get("panel_hours"), device_class=SensorDeviceClass.DURATION,
                                  native_unit_of_measurement=UnitOfTime.HOURS,
                                  state_class=SensorStateClass.TOTAL_INCREASING,
                                  entity_category=EntityCategory.DIAGNOSTIC),
    WebosFoundrySensorDescription(key="panel_temperature", name="Panel temperature", coordinator="details",
                                  value_fn=_get("panel_temperature_c"), device_class=SensorDeviceClass.TEMPERATURE,
                                  native_unit_of_measurement=UnitOfTemperature.CELSIUS,
                                  state_class=SensorStateClass.MEASUREMENT,
                                  entity_category=EntityCategory.DIAGNOSTIC),
    WebosFoundrySensorDescription(key="sleep_timer", name="Sleep timer", coordinator="details",
                                  value_fn=_get("sleep_timer")),
    WebosFoundrySensorDescription(key="usage_today", name="Top app today", coordinator="details", value_fn=_top_app,
                                  attrs_fn=lambda d: {"apps": d.get("usage_today") or []}),
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    data = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(WebosFoundrySensor(data[d.coordinator], entry, d) for d in SENSORS)


class WebosFoundrySensor(WebosFoundryEntity, SensorEntity):
    entity_description: WebosFoundrySensorDescription

    def __init__(self, coordinator, entry: ConfigEntry, description: WebosFoundrySensorDescription) -> None:
        super().__init__(coordinator, entry, description.key)
        self.entity_description = description

    @property
    def native_value(self):
        return self.entity_description.value_fn(self.coordinator.data)

    @property
    def extra_state_attributes(self):
        fn = self.entity_description.attrs_fn
        return fn(self.coordinator.data) if fn else None
