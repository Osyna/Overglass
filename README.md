# webOS Foundry

A CLI (`wof`), HTTP API with web UI, and Home Assistant integration for controlling an LG webOS TV
that you have already rooted: status and sensors, remote control, toasts, spoken announcements,
on-screen cards, screenshots and live view, with a locked-down SSH key instead of a root shell.

> **The TV must already be rooted. This project does not root it.** Rooting is done with separate tools
> (see <https://www.webosbrew.org/> and the Homebrew Channel; slopbro and dejavuln-autoroot are
> examples). webOS Foundry needs the SSH access you get from that, once, to set itself up. It never asks
> for an LG account.

<!-- screenshot: docs/img/web-ui.png -->

## Three steps

1. **Root your TV** with the tool of your choice and keep the root SSH key it gives you.
2. **Pair:** `wof pair --host 192.168.1.50 --root-key ~/.ssh/tv_root_key`. This uses your root key once,
   creates a dedicated restricted key, installs the TV-side scripts and then forgets the root key.
3. **Serve and connect:** `wof serve --host 0.0.0.0 --token "$TOKEN"`, then add the **webOS Foundry**
   integration in Home Assistant (host, port `8765`, token), or just open the web UI.

## Features

* **Status and sensors:** power, foreground source/app, whether the Luma home replacement is in front,
  SoC temperature, volume/mute, ambient light, OLED panel hours and temperature, Pixel Refresher
  counters, power-on reason and history, input signal (resolution, refresh, HDR, VRR, ALLM), sleep
  timer and per-app usage today.
* **Remote:** wake (Wake-on-LAN), power off, home/back/D-pad/OK, HDMI 1-4, volume up/down, mute.
* **AI picture and sound settings:** read and set eight allow-listed settings (AI Picture Pro,
  AI Brightness, AI Genre, Super Resolution, Sound Mode, AI Sound, Clear Voice, AI Game Sound), with the
  TV's own scope and availability checks and read-back.
* **Notifications:** on-screen toast, spoken announcement through the TV speaker (Audio Guidance TTS,
  restored afterwards), and an overlay card (title, body, lines, optional image, colour, position,
  duration) drawn over HDMI without changing the foreground app.
* **Screenshot and live view:** HDMI screenshot (jpg/png) and an optional native fast-capture client for a
  low-resolution live stream. On the reference TV it measured 30.4 fps at 160x90 requesting 30 fps and
  60.1 fps requesting 60; those are one TV's numbers.
* **Image/audio processing:** push a PNG/JPEG or WAV through the TV's own AI picture or sound pipeline
  and get the result back.
* **Least privilege:** after pairing, the TV accepts only a fixed command grammar through a forced
  command; there is no verb for erase, firmware, Pixel Refresher triggering, accounts or commissioning
  ([docs/SAFETY.md](docs/SAFETY.md)).
* **Zero Python dependencies** for the core (stdlib only); the Home Assistant integration uses only
  Home Assistant's own `aiohttp`.

## Install

Requires Python 3.9+, `ssh` and `ssh-keygen`. There is no PyPI package yet: the server and CLI read
`web/` and `tv-assets/` from the source tree, so install from a checkout.

```sh
git clone https://github.com/webos-foundry/webos-foundry
cd webos-foundry
pip install -e .
wof pair --host 192.168.1.50 --root-key ~/.ssh/tv_root_key
wof doctor
wof serve                      # http://127.0.0.1:8765/
```

Docker and systemd instructions are in [docs/INSTALL.md](docs/INSTALL.md).

## Usage

```sh
wof status --json
wof notify toast "Dinner is ready"
wof overlay show --title Dinner --body "It is ready." --kind success --seconds 10
wof remote hdmi 2
wof screenshot /tmp/tv.jpg --width 960
```

```sh
curl -H "Authorization: Bearer TOKEN" http://host:8765/api/status
curl -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
     -d '{"message": "Dinner is ready"}' http://host:8765/api/notify/toast
```

`GET /api` on a running server returns the full self-describing route catalogue.

## Home Assistant

A custom integration (`homeassistant/custom_components/webos_foundry`) polls the API (status every
15 s, details every 60 s) and provides sensors, binary sensors, a Wake button and services `toast`,
`say`, `overlay_show`, `overlay_hide`, `remote` and `set_setting`. Copy that folder into your own
`config/custom_components/`; see [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md) for HACS and manual
install, the entity list and automation examples.

## Documentation

* [docs/INSTALL.md](docs/INSTALL.md): prerequisites, pairing, Docker, systemd, troubleshooting
* [docs/CLI.md](docs/CLI.md): every `wof` command
* [docs/API.md](docs/API.md): HTTP API and authentication
* [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md): integration, entities, services, automations
* [docs/FINDINGS.md](docs/FINDINGS.md): what a rooted webOS 10.x TV exposes, with evidence
* [docs/SAFETY.md](docs/SAFETY.md): least privilege, uninstall, privacy
* [ARCHITECTURE.md](ARCHITECTURE.md): the contract between the modules
* [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md)

## Safety and privacy in one paragraph

Screenshots and the live view show whatever the HDMI input displays. The HTTP API controls your TV: keep it
on loopback or a trusted LAN, use the token, and do not expose it to the Internet. `wof uninstall` removes
the TV-side files, the overlay app and the vtcap role but you must delete the restricted `authorized_keys`
line by hand (explained in [docs/SAFETY.md](docs/SAFETY.md)).

Tested on one LG OLED C-series TV on webOS 10.x; other models and firmware are untested.

## Contributing

Most of this project can be developed and tested without a TV: `python3 -m pytest tests/`,
`node --check` on the JS, `sh -n` on the shell. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
