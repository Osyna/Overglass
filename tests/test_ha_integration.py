"""Offline tests for the Home Assistant integration (no TV, no real network).

Homeassistant and pytest-homeassistant-custom-component are not dependencies of this repo, so:

* ``api.py`` is HA-free and is tested for real against a local ``aiohttp.test_utils.TestServer``.
* The HA-facing modules (config_flow, coordinators, entities, services) run against a minimal
  hand-written stand-in for the ``homeassistant`` modules they import, wired to the same local
  fake server. This catches logic/typo errors in our code; it cannot catch a mismatch with the
  real HA API. It is skipped when a real ``homeassistant`` is installed (use
  pytest-homeassistant-custom-component there).
"""
from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import importlib.util
import json
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import MagicMock

import aiohttp
import pytest
import voluptuous as vol
from aiohttp import web
from aiohttp.test_utils import TestServer

HA_DIR = Path(__file__).resolve().parents[1] / "homeassistant"
PKG_DIR = HA_DIR / "custom_components" / "webos_foundry"
TOKEN = "s3cret"

STATUS = {"power": "on", "raw_power_state": "Active", "source": "HDMI 1", "app_id": "com.webos.app.hdmi1",
          "is_luma": False, "temperature_c": 51, "temperature_source": "soc", "volume": 12, "muted": False}
DETAILS = {"lux": 87, "panel_hours": 1234, "panel_temperature_c": 38, "sleep_timer": "off",
           "usage_today": [{"app_id": "netflix", "seconds": 60, "launches": 1},
                           {"app_id": "youtube.leanback.v4", "seconds": 600, "launches": 2}]}
SETTINGS = [{"category": "sound", "key": "aiSound", "label": "AI Sound", "value": "off", "values": ["on", "off"],
             "available": True, "context": {"input": "hdmi1"}}]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"wof_ha_{name}", PKG_DIR / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


api_mod = _load("api")
const = _load("const")


def fake_tv_app(calls: list, status=STATUS, token=TOKEN) -> web.Application:
    """Stands in for `wof serve`; records (method, path, body, Authorization)."""

    async def handle(request: web.Request):
        text = await request.text()
        body = json.loads(text) if text else None
        auth = request.headers.get("Authorization")
        calls.append((request.method, request.path, body, auth))
        if request.path != "/api/health" and auth != f"Bearer {token}":
            return web.json_response({"error": "Unauthorized"}, status=401)
        if request.path == "/api/health":
            return web.json_response({"paired": True, "tv_host": "192.168.1.50"})
        if request.path == "/api/status":
            return web.json_response(status)
        if request.path == "/api/details":
            return web.json_response(DETAILS)
        if request.path == "/api/settings":
            return web.json_response(SETTINGS)
        if request.path == "/api/remote/boom":
            return web.json_response({"error": "TV is reserved by a job"}, status=409)
        if request.path == "/api/remote/text":
            return web.Response(text="gateway down", status=502)
        return web.json_response({"message": "ok"})

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handle)
    return app


async def with_tv(fn, **kw):
    calls: list = []
    server = TestServer(fake_tv_app(calls, **kw))
    await server.start_server()
    try:
        async with aiohttp.ClientSession() as session:
            return await fn(server, session, calls)
    finally:
        await server.close()


# ---------------------------------------------------------------- api.py


def test_api_builds_every_route():
    async def go(server, session, calls):
        api = api_mod.WebosFoundryApi(session, "127.0.0.1", server.port, TOKEN)
        await api.get_health()
        await api.get_status()
        await api.get_details()
        await api.get_settings()
        await api.set_setting("sound", "aiSound", "on", {"input": "hdmi1"})
        await api.remote("wake")
        await api.remote("hdmi", 2)
        await api.notify_toast("hi")
        await api.notify_say("hello")
        await api.notify_say("hello", 10)
        await api.overlay_show({"title": "T", "seconds": 5})
        await api.overlay_hide()
        return calls

    bearer = f"Bearer {TOKEN}"
    assert asyncio.run(with_tv(go)) == [
        ("GET", "/api/health", None, None),  # health is sent without a token
        ("GET", "/api/status", None, bearer),
        ("GET", "/api/details", None, bearer),
        ("GET", "/api/settings", None, bearer),
        ("PUT", "/api/settings/sound/aiSound", {"value": "on", "context": {"input": "hdmi1"}}, bearer),
        ("POST", "/api/remote/wake", None, bearer),
        ("POST", "/api/remote/hdmi", {"value": 2}, bearer),
        ("POST", "/api/notify/toast", {"message": "hi"}, bearer),
        ("POST", "/api/notify/say", {"message": "hello"}, bearer),
        ("POST", "/api/notify/say", {"message": "hello", "volume": 10}, bearer),
        ("POST", "/api/overlay", {"title": "T", "seconds": 5}, bearer),
        ("POST", "/api/overlay", {"hide": True}, bearer),
    ]


def test_api_errors():
    async def go(server, session, _calls):
        bad = api_mod.WebosFoundryApi(session, "127.0.0.1", server.port, "wrong")
        with pytest.raises(api_mod.WebosFoundryAuthError, match="Unauthorized"):
            await bad.get_status()
        api = api_mod.WebosFoundryApi(session, "127.0.0.1", server.port, TOKEN)
        with pytest.raises(api_mod.WebosFoundryApiError, match="reserved") as exc:
            await api.remote("boom")
        assert exc.value.status == 409 and not isinstance(exc.value, api_mod.WebosFoundryAuthError)
        with pytest.raises(api_mod.WebosFoundryApiError, match="gateway down"):
            await api.remote("text")
        port = server.port
        await server.close()
        with pytest.raises(api_mod.WebosFoundryConnectionError):
            await api_mod.WebosFoundryApi(session, "127.0.0.1", port, TOKEN).get_status()

    asyncio.run(with_tv(go))


def test_api_ipv6_base_url():
    assert api_mod.WebosFoundryApi(None, "fe80::1", 8765, "t")._base == "http://[fe80::1]:8765"


# ---------------------------------------------------------------- static files


def test_manifest_strings_services():
    manifest = json.loads((PKG_DIR / "manifest.json").read_text())
    assert manifest["domain"] == const.DOMAIN == "webos_foundry"
    assert manifest["config_flow"] is True and manifest["iot_class"] == "local_polling"
    assert manifest["requirements"] == [] and manifest["version"] == "0.1.0"
    strings = json.loads((PKG_DIR / "strings.json").read_text())
    assert strings == json.loads((PKG_DIR / "translations" / "en.json").read_text())
    for step in strings["config"]["step"].values():
        assert set(step["data"]) <= {"host", "port", "token"}
    yaml = pytest.importorskip("yaml")
    services = yaml.safe_load((PKG_DIR / "services.yaml").read_text())
    assert set(services) == {"toast", "say", "overlay_show", "overlay_hide", "remote", "set_setting"}
    assert all("config_entry_id" in s["fields"] for s in services.values())


# ---------------------------------------------------------------- HA stand-in


class _Stub(types.ModuleType):
    def __getattr__(self, name):  # enums/constants (SensorDeviceClass.X, LIGHT_LUX, ...)
        if name.startswith("__"):
            raise AttributeError(name)
        return MagicMock(name=name)


class UpdateFailed(Exception):
    pass


class ConfigEntryAuthFailed(Exception):
    pass


class HomeAssistantError(Exception):
    pass


class ServiceValidationError(HomeAssistantError):
    pass


class _Coordinator:
    def __init__(self, hass, logger, *, name, update_method, update_interval):
        self.name, self.update_method, self.update_interval = name, update_method, update_interval
        self.data, self.last_update_success = None, True

    async def async_refresh(self):
        try:
            self.data, self.last_update_success = await self.update_method(), True
        except UpdateFailed:
            self.last_update_success = False

    async def async_config_entry_first_refresh(self):
        await self.async_refresh()
        if not self.last_update_success:
            raise UpdateFailed("first refresh failed")

    async def async_request_refresh(self):
        await self.async_refresh()


class _CoordinatorEntity:
    def __init__(self, coordinator):
        self.coordinator = coordinator


class _ConfigFlow:
    configured: set = set()

    def __init_subclass__(cls, domain=None, **kw):
        cls.domain = domain

    async def async_set_unique_id(self, uid):
        self.unique_id = uid

    def _abort_if_unique_id_configured(self):
        if self.unique_id in self.configured:
            raise AbortFlow("already_configured")

    def async_create_entry(self, *, title, data):
        return {"type": "create_entry", "title": title, "data": data}

    def async_show_form(self, *, step_id, data_schema, errors=None):
        return {"type": "form", "step_id": step_id, "schema": data_schema, "errors": errors}

    def async_abort(self, *, reason):
        return {"type": "abort", "reason": reason}


class AbortFlow(Exception):
    pass


@dataclass(frozen=True, kw_only=True)
class _Description:
    key: str
    name: str | None = None
    device_class: object = None
    native_unit_of_measurement: object = None
    state_class: object = None
    entity_category: object = None


class _Services:
    def __init__(self):
        self.reg = {}

    def async_register(self, domain, name, handler, schema=None):
        self.reg[(domain, name)] = (handler, schema)

    def has_service(self, domain, name):
        return (domain, name) in self.reg

    def async_remove(self, domain, name):
        del self.reg[(domain, name)]


class _Hass:
    def __init__(self, session):
        self.session, self.data, self.services = session, {}, _Services()
        self.config_entries = types.SimpleNamespace(
            async_forward_entry_setups=_async_noop, async_unload_platforms=_async_true
        )


async def _async_noop(*a):
    return None


async def _async_true(*a):
    return True


def _has_at_least_one_key(*keys):
    def check(value):
        if not any(k in value for k in keys):
            raise vol.Invalid(f"expected at least one of {keys}")
        return value

    return check


def _install_stubs():
    def mod(name, **attrs):
        m = _Stub(name)
        m.__dict__.update(attrs)
        sys.modules[name] = m
        parent, _, child = name.rpartition(".")
        if parent:  # `from homeassistant import config_entries` reads the attribute
            setattr(sys.modules[parent], child, m)
        return m

    cv = types.SimpleNamespace(
        string=lambda v: str(v),
        ensure_list=lambda v: v if isinstance(v, list) else [v],
        match_all=lambda v: v,
        has_at_least_one_key=_has_at_least_one_key,
    )
    mod("homeassistant")
    mod("homeassistant.config_entries", ConfigEntry=object, ConfigFlow=_ConfigFlow)
    mod("homeassistant.const", CONF_HOST="host", CONF_PORT="port")
    mod("homeassistant.core", HomeAssistant=object, ServiceCall=object)
    mod("homeassistant.exceptions", ConfigEntryAuthFailed=ConfigEntryAuthFailed, HomeAssistantError=HomeAssistantError,
        ServiceValidationError=ServiceValidationError)
    helpers = mod("homeassistant.helpers", config_validation=cv)
    mod("homeassistant.helpers.aiohttp_client", async_get_clientsession=lambda hass: hass.session)
    mod("homeassistant.helpers.update_coordinator", DataUpdateCoordinator=_Coordinator, UpdateFailed=UpdateFailed,
        CoordinatorEntity=_CoordinatorEntity)
    mod("homeassistant.helpers.device_registry", DeviceInfo=dict)
    mod("homeassistant.helpers.entity_platform")
    mod("homeassistant.components")
    mod("homeassistant.components.sensor", SensorEntity=object, SensorEntityDescription=_Description)
    mod("homeassistant.components.binary_sensor", BinarySensorEntity=object)
    mod("homeassistant.components.button", ButtonEntity=object)
    return helpers


@pytest.fixture
def ha():
    try:  # not find_spec: ./homeassistant/ in this repo is a namespace package
        importlib.metadata.version("homeassistant")
    except importlib.metadata.PackageNotFoundError:
        pass
    else:
        pytest.skip("real homeassistant installed; stand-in tests are for environments without it")
    saved = dict(sys.modules)
    _install_stubs()
    sys.path.insert(0, str(HA_DIR))
    try:
        yield types.SimpleNamespace(
            pkg=importlib.import_module("custom_components.webos_foundry"),
            config_flow=importlib.import_module("custom_components.webos_foundry.config_flow"),
            sensor=importlib.import_module("custom_components.webos_foundry.sensor"),
            binary_sensor=importlib.import_module("custom_components.webos_foundry.binary_sensor"),
            button=importlib.import_module("custom_components.webos_foundry.button"),
            api=importlib.import_module("custom_components.webos_foundry.api"),
        )
    finally:
        sys.path.remove(str(HA_DIR))
        for name in set(sys.modules) - set(saved):
            del sys.modules[name]
        sys.modules.update(saved)


def _entry(server, entry_id="e1", token=TOKEN):
    return types.SimpleNamespace(entry_id=entry_id, data={"host": "127.0.0.1", "port": server.port, "token": token})


async def _setup(ha, server, session, entry=None):
    hass = _Hass(session)
    entry = entry or _entry(server)
    assert await ha.pkg.async_setup_entry(hass, entry)
    return hass, entry


async def _platform_entities(platform, hass, entry):
    out = []
    await platform.async_setup_entry(hass, entry, out.extend)
    return out


# ---------------------------------------------------------------- coordinators and entities


def test_setup_entities_and_unload(ha):
    async def go(server, session, calls):
        hass, entry = await _setup(ha, server, session)
        data = hass.data["webos_foundry"]["e1"]
        assert data["status"].update_interval.total_seconds() == 15
        assert data["details"].update_interval.total_seconds() == 60

        sensors = {e.entity_description.key: e for e in await _platform_entities(ha.sensor, hass, entry)}
        assert {k: e.native_value for k, e in sensors.items()} == {
            "power_state": "on", "source": "HDMI 1", "temperature": 51, "volume": 12, "lux": 87,
            "panel_hours": 1234, "panel_temperature": 38, "sleep_timer": "off", "usage_today": "youtube.leanback.v4",
        }
        assert sensors["usage_today"].extra_state_attributes == {"apps": DETAILS["usage_today"]}
        assert sensors["volume"].extra_state_attributes == {"muted": False}
        assert sensors["sleep_timer"].extra_state_attributes is None
        assert sensors["lux"]._attr_unique_id == "e1_lux"
        assert sensors["lux"]._attr_device_info["identifiers"] == {("webos_foundry", "e1")}

        binary = {e._key: e for e in await _platform_entities(ha.binary_sensor, hass, entry)}
        assert binary["powered"].is_on is True and binary["is_luma"].is_on is False
        data["status"].data = {"power": "unknown", "is_luma": None}
        assert binary["powered"].is_on is None and binary["is_luma"].is_on is None
        data["details"].data = {"usage_today": None}
        assert sensors["usage_today"].native_value is None and sensors["usage_today"].extra_state_attributes == {"apps": []}

        (wake,) = await _platform_entities(ha.button, hass, entry)
        calls.clear()
        await wake.async_press()
        assert calls[0][:3] == ("POST", "/api/remote/wake", None)

        assert set(hass.services.reg) == {("webos_foundry", n) for n in
                                          ("toast", "say", "overlay_show", "overlay_hide", "remote", "set_setting")}
        assert await ha.pkg.async_unload_entry(hass, entry)
        assert hass.data["webos_foundry"] == {} and hass.services.reg == {}

    asyncio.run(with_tv(go))


def test_setup_failures(ha):
    async def go(server, session, calls):
        with pytest.raises(ConfigEntryAuthFailed, match="Unauthorized"):
            await _setup(ha, server, session, _entry(server, token="wrong"))
        port = server.port
        await server.close()
        entry = types.SimpleNamespace(entry_id="e", data={"host": "127.0.0.1", "port": port, "token": TOKEN})
        with pytest.raises(UpdateFailed, match="first refresh failed"):
            await _setup(ha, server, session, entry)

    asyncio.run(with_tv(go))


# ---------------------------------------------------------------- services


async def _call(hass, name, data):
    handler, schema = hass.services.reg[("webos_foundry", name)]
    await handler(types.SimpleNamespace(data=schema(data)))


def test_services(ha):
    async def go(server, session, calls):
        hass, _ = await _setup(ha, server, session)
        calls.clear()
        await _call(hass, "toast", {"message": "hi"})
        await _call(hass, "say", {"message": "yo", "volume": 10.0})
        await _call(hass, "overlay_show", {"title": "T", "lines": "one", "kind": "info", "seconds": "5"})
        await _call(hass, "overlay_hide", {})
        await _call(hass, "remote", {"action": "hdmi", "value": 2})
        await _call(hass, "set_setting", {"category": "sound", "key": "aiSound", "value": "on"})
        assert [c[:3] for c in calls if c[1] != "/api/status"] == [
            ("POST", "/api/notify/toast", {"message": "hi"}),
            ("POST", "/api/notify/say", {"message": "yo", "volume": 10}),
            ("POST", "/api/overlay", {"title": "T", "lines": ["one"], "kind": "info", "seconds": 5}),
            ("POST", "/api/overlay", {"hide": True}),
            ("POST", "/api/remote/hdmi", {"value": 2}),
            ("GET", "/api/settings", None),
            ("PUT", "/api/settings/sound/aiSound", {"value": "on", "context": {"input": "hdmi1"}}),
        ]
        assert ("GET", "/api/status", None, f"Bearer {TOKEN}") in calls  # remote refreshes status afterwards

        with pytest.raises(ServiceValidationError, match="Unknown setting"):
            await _call(hass, "set_setting", {"category": "sound", "key": "nope", "value": "on"})
        with pytest.raises(HomeAssistantError, match="reserved"):
            await _call(hass, "remote", {"action": "boom"})
        with pytest.raises(vol.Invalid):
            await _call(hass, "overlay_show", {"kind": "info"})  # no title/body/lines/image
        with pytest.raises(vol.Invalid):
            await _call(hass, "overlay_show", {"title": "T", "kind": "purple"})
        with pytest.raises(ServiceValidationError, match="Unknown"):
            await _call(hass, "toast", {"message": "hi", "config_entry_id": "other"})

        # a second TV makes config_entry_id mandatory; with it the right one is used
        await ha.pkg.async_setup_entry(hass, _entry(server, "e2"))
        with pytest.raises(ServiceValidationError, match="config_entry_id"):
            await _call(hass, "toast", {"message": "hi"})
        calls.clear()
        await _call(hass, "toast", {"message": "hi", "config_entry_id": "e2"})
        assert calls[0][:3] == ("POST", "/api/notify/toast", {"message": "hi"})

    asyncio.run(with_tv(go))


# ---------------------------------------------------------------- config flow


def _user_input(server, token=TOKEN):
    return {"host": " 127.0.0.1 ", "port": server.port, "token": token}


def test_config_flow(ha):
    async def go(server, session, calls):
        flow = ha.config_flow.WebosFoundryConfigFlow()
        flow.hass = _Hass(session)

        form = await flow.async_step_user()
        assert form["type"] == "form" and form["errors"] == {}
        assert form["schema"]({"host": "h", "token": "t"})["port"] == 8765  # default port

        result = await flow.async_step_user(_user_input(server))
        assert result["type"] == "create_entry"
        assert result["data"] == {"host": "127.0.0.1", "port": server.port, "token": TOKEN}
        assert flow.unique_id == f"127.0.0.1:{server.port}"
        assert [c[1] for c in calls] == ["/api/health", "/api/status"]

        result = await flow.async_step_user(_user_input(server, "wrong"))
        assert result["type"] == "form" and result["errors"] == {"base": "invalid_auth"}

        flow.configured = {f"127.0.0.1:{server.port}"}
        with pytest.raises(AbortFlow, match="already_configured"):
            await flow.async_step_user(_user_input(server))

        port = server.port
        await server.close()
        flow.configured = set()
        result = await flow.async_step_user({"host": "127.0.0.1", "port": port, "token": TOKEN})
        assert result["errors"] == {"base": "cannot_connect"}

    asyncio.run(with_tv(go))


def _flow_error(ha, handler) -> dict:
    """Run the user step against a server answering every request through `handler`."""

    async def go():
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", handler)
        server = TestServer(app)
        await server.start_server()
        try:
            async with aiohttp.ClientSession() as session:
                flow = ha.config_flow.WebosFoundryConfigFlow()
                flow.hass = _Hass(session)
                return (await flow.async_step_user(_user_input(server)))["errors"]
        finally:
            await server.close()

    return asyncio.run(go())


def test_config_flow_unpaired_and_tv_error(ha):
    async def unpaired(_request):
        return web.json_response({"paired": False, "tv_host": None})

    async def tv_down(request):  # health ok, status 5xx
        if request.path == "/api/health":
            return web.json_response({"paired": True, "tv_host": "x"})
        return web.json_response({"error": "ssh failed"}, status=502)

    assert _flow_error(ha, unpaired) == {"base": "not_paired"}
    assert _flow_error(ha, tv_down) == {"base": "tv_error"}
