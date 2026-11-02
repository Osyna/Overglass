# Home Assistant integration

The custom integration `webos_foundry` talks **only** to the `wof serve` HTTP API over the network.
It never uses SSH and no key is ever stored in Home Assistant. It has no requirements beyond Home
Assistant's own `aiohttp` (`"iot_class": "local_polling"`).

## Before you start

1. Pair and install ([INSTALL.md](INSTALL.md)): `wof pair`, `wof install`, `wof doctor`.
2. Run the server where Home Assistant can reach it, with a token (required on any non-loopback bind):

   ```sh
   wof serve --host 0.0.0.0 --port 8765 --token "$TOKEN"
   ```

   Check from the HA host: `curl http://host:8765/api/health` should return `{"paired": true, ...}`.
3. For the **Wake** button, tell the server the TV's MAC: `wof config set mac AA:BB:CC:DD:EE:FF`.
   The Wake-on-LAN packet is sent by the `wof serve` host, not by Home Assistant, so that host must be on
   the TV's LAN (or set `broadcast` accordingly).

## Install the integration

**Manual.** Copy `homeassistant/custom_components/webos_foundry/` from this repository into your
Home Assistant config directory as `config/custom_components/webos_foundry/`, then restart Home Assistant.

**HACS (custom repository).** HACS → ⋮ → *Custom repositories* → add
`https://github.com/webos-foundry/webos-foundry` with category *Integration* → download *webOS Foundry*
→ restart Home Assistant. HACS looks for `custom_components/<domain>/` at the repository root, but this
repository keeps the integration under `homeassistant/custom_components/`; unless a root-level layout or
`hacs.json` is added, HACS will not find it and you should use the manual copy.

## Add it

*Settings → Devices & services → Add integration → webOS Foundry*, then enter:

| Field | Value |
| --- | --- |
| Host | Address of the machine running `wof serve` (**not** the TV) |
| Port | `8765` (the `wof serve` default) |
| Token | The `server_token` (`wof serve --generate-token`, or `--token`) |

The form tests `GET /api/health` (must report `paired: true`) and then `GET /api/status` with your
token, and reports `cannot_connect`, `invalid_auth`, `not_paired` or `tv_error`. If the token later
changes, Home Assistant starts a re-authentication flow that asks for the new token only.

One config entry per `wof serve` instance. The device is named `webOS TV (<host>)`.

## Polling

Two coordinators: `GET /api/status` every **15 s** and `GET /api/details` every **60 s**. The status
poll does not take the TV-side lock, so entities keep updating while a processing job runs.

## Entities

Entity IDs follow Home Assistant's `<device name>_<entity name>` rule, so with the host `192.168.1.50`
the power sensor is `sensor.webos_tv_192_168_1_50_power_state`. The IDs below use `<tv>` for that prefix.

| Entity | Source | Meaning |
| --- | --- | --- |
| `sensor.<tv>_power_state` | status | `on`, `off` or `unknown`; attribute `raw_power_state` |
| `sensor.<tv>_source` | status | `HDMI 1`…`HDMI 4`, `Luma`, `LG Home`, `Off` or another app; attribute `app_id` |
| `sensor.<tv>_temperature` | status | SoC die temperature, °C (not room/panel temperature); attribute `temperature_source` |
| `sensor.<tv>_volume` | status | TV speaker volume, %; attribute `muted` (unavailable/`None` in standby) |
| `sensor.<tv>_ambient_light` | details | Ambient light sensor, lx |
| `sensor.<tv>_panel_hours` | details | OLED panel hours (diagnostic, `total_increasing`) |
| `sensor.<tv>_panel_temperature` | details | Panel temperature, whole °C (diagnostic; scaling inferred, not calibrated) |
| `sensor.<tv>_sleep_timer` | details | Sleep timer setting |
| `sensor.<tv>_top_app_today` | details | App/input with most seconds today; attribute `apps` = the full `usage_today` list `[{"app_id", "seconds", "launches"}]` |
| `binary_sensor.<tv>_powered` | status | On when `power` is `on`; unknown while the state cannot be read |
| `binary_sensor.<tv>_luma_in_front` | status | `is_luma`: the Luma home replacement is the foreground app |
| `button.<tv>_wake` | server | Sends the Wake-on-LAN packet from the `wof serve` host |

A field the TV does not report is `null` in the API and makes only its own entity unknown.

No mute/power switch or `media_player` is provided: use the `remote` service (`mute`, `unmute`,
`power_off`, ...), or the existing core `webostv` integration if you pair that separately.

## Services

All services take an optional `config_entry_id` (required only if more than one TV is configured).
They call the matching HTTP routes ([API.md](API.md)) and raise a Home Assistant error carrying the
TV's message on failure.

| Service | Fields | Route |
| --- | --- | --- |
| `webos_foundry.toast` | `message` | `POST /api/notify/toast` |
| `webos_foundry.say` | `message`, `volume` (1-40, optional) | `POST /api/notify/say` |
| `webos_foundry.overlay_show` | `title`, `body`, `lines` (list), `image`, `kind`, `position`, `seconds` (at least one of title/body/lines/image) | `POST /api/overlay` |
| `webos_foundry.overlay_hide` | none | `POST /api/overlay` with `{"hide": true}` |
| `webos_foundry.remote` | `action`, `value` (only `hdmi`: 1-4) | `POST /api/remote/{action}` |
| `webos_foundry.set_setting` | `category`, `key`, `value` | `PUT /api/settings/{category}/{key}`; the integration looks up the current `context` for you |

`say` and `overlay_show` need the TV on; `say` fails with a busy error while a processing job or
another announcement holds the TV. Overlay limits (title ≤ 80, body ≤ 400, ≤ 10 lines of ≤ 120,
`seconds` 0-300) are in [CLI.md](CLI.md#wof-overlay).

### Developer Tools examples

```yaml
action: webos_foundry.toast
data:
  message: Dinner is ready
```

```yaml
action: webos_foundry.remote
data:
  action: hdmi
  value: 2
```

```yaml
action: webos_foundry.set_setting
data:
  category: sound
  key: aiSound
  value: "on"
```

(On Home Assistant versions older than 2024.8 use `service:` instead of `action:`.)

## Automation examples

**Announce when the washer finishes** (replace the entity with your own washer sensor; the condition
skips the announcement while the TV is off, because `say` and cards need it on):

```yaml
automation:
  - alias: Announce washer finished on the TV
    trigger:
      - platform: state
        entity_id: sensor.washer_state        # your washer's entity
        from: running
        to: finished
    condition:
      - condition: state
        entity_id: binary_sensor.webos_tv_192_168_1_50_powered
        state: "on"
    action:
      - action: webos_foundry.say
        data:
          message: The washing machine has finished.
          volume: 15
      - action: webos_foundry.overlay_show
        data:
          title: Laundry
          body: The washing machine has finished.
          kind: success
          position: top-right
          seconds: 15
```

**Show a card when a Home Assistant person arrives:**

```yaml
automation:
  - alias: Welcome card on the TV
    trigger:
      - platform: state
        entity_id: person.alex
        to: home
    condition:
      - condition: state
        entity_id: binary_sensor.webos_tv_192_168_1_50_powered
        state: "on"
    action:
      - action: webos_foundry.overlay_show
        data:
          title: "{{ trigger.to_state.name }} is home"
          lines:
            - "{{ now().strftime('%H:%M') }}"
          kind: info
          position: bottom-left
          seconds: 10
```

**Wake the TV and pick HDMI 1 with a script** (the wake only sends a packet; give the TV time to
boot before switching input):

```yaml
script:
  tv_hdmi1:
    sequence:
      - action: button.press
        target:
          entity_id: button.webos_tv_192_168_1_50_wake
      - wait_template: "{{ is_state('binary_sensor.webos_tv_192_168_1_50_powered', 'on') }}"
        timeout: "00:01:00"
      - action: webos_foundry.remote
        data:
          action: hdmi
          value: 1
```

## Troubleshooting

* `cannot_connect`: wrong host/port, firewall, or `wof serve` bound to `127.0.0.1` only.
* `invalid_auth`: the token does not match `server_token` on the server host.
* `not_paired`: the server has no TV configured; run `wof pair` on the server host.
* `tv_error`: the server is up but the TV did not answer; run `wof doctor` on the server host.
* Entities show unknown while the TV is in deep standby: the status poll needs SSH reachable on
  the TV; the reference TV kept it reachable in normal standby.
