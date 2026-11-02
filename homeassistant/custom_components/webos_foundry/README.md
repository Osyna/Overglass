# webOS Foundry for Home Assistant

Talks only to the `wof serve` HTTP API (`http://<host>:<port>`, `Authorization: Bearer <token>`). It never uses SSH and holds no key; the TV is paired on the machine that runs `wof serve`.

## Install

HACS custom repositories need `custom_components/` at the repository root, which this repo does not have (it lives under `homeassistant/`), so install by hand:

```sh
cp -r homeassistant/custom_components/webos_foundry <HA config>/custom_components/
```

Restart Home Assistant, then **Settings → Devices & services → Add integration → webOS Foundry**.

Server side: `wof serve --bind 0.0.0.0 --token <token>` (a non-loopback bind refuses to start without a token). Enter that host, the port (default 8765) and the token. Setup checks `GET /api/health` (must report a paired TV), then `GET /api/status` with the token. A wrong token later triggers Home Assistant's re-authentication.

## Entities

Two `DataUpdateCoordinator`s: `/api/status` every 15 s and `/api/details` every 60 s. Setup requires status to work; details can fail while the TV is in standby and only makes its sensors unavailable.

| Platform | Entities |
| --- | --- |
| `sensor` | Power state, Source (attribute `app_id`), Temperature (°C), Volume (attribute `muted`), Ambient light (lx), Panel hours, Panel temperature, Sleep timer, Top app today (attribute `apps`: every `{app_id, seconds, launches}`) |
| `binary_sensor` | Powered, Luma in front |
| `button` | Wake (Wake-on-LAN sent by the `wof serve` host; its config needs `mac`) |

## Services

Every service takes an optional `config_entry_id`; it may be left out when only one TV is configured.

```yaml
action: webos_foundry.toast
data: {message: Dinner is ready}
---
action: webos_foundry.say
data: {message: Dinner is ready, volume: 10}
---
action: webos_foundry.overlay_show
data: {title: Dinner, body: It is ready., kind: success, position: top-right, seconds: 10}
---
action: webos_foundry.overlay_hide
---
action: webos_foundry.remote
data: {action: hdmi, value: 1}
---
action: webos_foundry.set_setting
data: {category: sound, key: aiSound, value: "on"}
```

`set_setting` first reads `GET /api/settings` to get the setting's current `context` (its input/mode scope) and sends it back with the value, so a setting is only changed in the scope the TV reports. Errors the server returns (TV in standby, TV reserved by a processing job, invalid card) surface as the service error message.
