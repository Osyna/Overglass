# CLI reference (`wof`)

Global option: `--config-dir DIR` overrides `WEBOS_FOUNDRY_HOME` (default `~/.config/webos-foundry`).
Every command except `pair`, `config` and `serve --generate-token` needs a paired TV; without one
it exits with an error pointing at `wof pair --host <ip>`.

Example outputs below are **illustrative**: JSON shapes come from [ARCHITECTURE.md §4](../ARCHITECTURE.md)
and from the proven reference implementation; the numbers are sample values, not measurements.
Commands that talk to the TV only ever send verbs from the dispatcher grammar
([ARCHITECTURE.md §3](../ARCHITECTURE.md), [SAFETY.md](SAFETY.md)).

| Command | Purpose |
| --- | --- |
| [`wof pair`](#wof-pair) | One-time bootstrap using your existing root key |
| [`wof install` / `update` / `uninstall`](#wof-install--update--uninstall) | Manage the TV-side files |
| [`wof doctor`](#wof-doctor) | Check local tools, config and TV |
| [`wof status`](#wof-status) / [`wof details`](#wof-details) | Read-only TV state |
| [`wof remote`](#wof-remote) | Remote keys, HDMI input, volume, power |
| [`wof settings`](#wof-settings) | AI picture/sound settings |
| [`wof notify`](#wof-notify) | Toast, spoken announcement |
| [`wof overlay`](#wof-overlay) | On-screen card |
| [`wof scene`](#wof-scene) | Save and run a named sequence of steps |
| [`wof schedule`](#wof-schedule) | Run a scene automatically at a time of day |
| [`wof webhook`](#wof-webhook) | A private link that runs one scene |
| [`wof connector`](#wof-connector) | Pollable data sources rendered as an overlay card |
| [`wof screenshot`](#wof-screenshot) / [`wof stream`](#wof-stream) | Capture the HDMI picture |
| [`wof config`](#wof-config) | Show / edit the local config |

## wof pair

```
wof pair --host IP --root-key PATH [--port 22]
```

Pins the TV's host key, creates a dedicated ed25519 key, pushes the dispatcher, appends one
restricted line to the TV's `authorized_keys`, saves the config and runs `wof install` with the new
key. Your root key is used for this one command and never stored. `--port` is the TV's SSH port.

```sh
wof pair --host 192.168.1.50 --root-key ~/.ssh/tv_root_key
```

The restricted line it appends:

```
command="sh /var/lib/webosbrew/webos-foundry/dispatch.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,restrict ssh-ed25519 AAAA... wof@<local hostname>
```

## wof install / update / uninstall

```
wof install [--no-overlay] [--vtcap auto|yes|no]
wof update
wof uninstall [--yes]
```

* `install` pushes the TV scripts (`status.sh`, `details.js`, `notify.js`, `settings.js`, `remote.js`,
  `process-image.js`, `process-audio.js`, `dispatch.sh`), installs the overlay app
  `dev.webosfoundry.overlay` (skip with `--no-overlay`) and, with `--vtcap auto` (default), the native
  capture client only if you built it locally; `yes` insists on it, `no` skips it.
* `update` re-pushes the plain scripts only (not the overlay or vtcap).
* `uninstall` asks for confirmation (skip with `--yes`) and runs the dispatcher's `uninstall-all`: it
  removes every file under `/var/lib/webosbrew/webos-foundry/`, the overlay app and the vtcap role.
  It **does not** delete the `authorized_keys` line; it prints that line so you can delete it by hand
  ([SAFETY.md](SAFETY.md) explains why).

## wof doctor

```
wof doctor
```

Checks `ssh` and `ssh-keygen`, that the config loads, that the TV answers over the restricted key,
and what `install` has put on the TV.

## wof status

```
wof status [--json]
```

```sh
wof status --json
```

```json
{
  "power": "on",
  "raw_power_state": "Active",
  "source": "HDMI 1",
  "app_id": "com.webos.app.hdmi1",
  "is_luma": false,
  "temperature_c": 66.0,
  "temperature_source": "soc",
  "volume": 12,
  "muted": false
}
```

`power` is `on` (Active/Screen Saver), `off` (Active Standby) or `unknown`. `volume`/`muted` are
`null` in standby. `temperature_c` is the SoC die temperature, not room or panel temperature, and
is `null` when unreadable. `is_luma` is true when the foreground app is the Luma home replacement.
Without `--json` the same fields are printed as readable lines.

## wof details

```
wof details [--json]
```

Read-only sensors; each field may be `null` when its TV service did not answer.

```json
{
  "lux": 42,
  "panel_hours": 1878,
  "panel_temperature_c": 30,
  "pixel_refresher": {"full_runs": 1, "full_last_panel_hours": 1200, "standby_runs": 3, "standby_last_panel_hours": 1700},
  "power_on_reason": "ON_BY_REMOTE_KEY",
  "power_history": [{"reason": "ON_BY_REMOTE_KEY", "panel_hours": 1878}],
  "signal": {"app_id": "com.webos.app.hdmi1", "width": 3840, "height": 2160, "fps": 120, "hdr": "sdr", "pixel_encoding": "rgb", "timing": "4k", "content_type": "graphics", "game_mode": true, "allm": true, "vrr": true},
  "sleep_timer": "off",
  "usage_today": [{"app_id": "com.webos.app.hdmi1", "seconds": 3180, "launches": 4}]
}
```

(`panel_temperature_c` is a whole-degree reading with inferred scaling, not a calibrated value.
`power_history` is newest first. `signal` is `null` when no source is connected.)

## wof remote

```
wof remote ACTION [VALUE]
```

`ACTION` is one of `wake`, `power_off`, `home`, `back`, `up`, `down`, `left`, `right`, `ok`, `mute`,
`unmute`, `volume_up`, `volume_down`, `hdmi` (with `VALUE` 1-4).

```sh
wof remote hdmi 2
wof remote volume_up
wof remote wake          # UDP Wake-on-LAN from this machine; needs `mac` in the config
```

Each action waits for the TV to confirm the change and prints its confirmation message. `wake` only
sends the magic packet and does not touch SSH; read `wof status` to confirm the TV woke. Volume is
the TV speaker's 0-100 scale, moved one step at a time with read-back.

## wof settings

```
wof settings list [--json]
wof settings set CATEGORY KEY VALUE
```

Only these settings can ever be read or written:

| Category | Key | Label |
| --- | --- | --- |
| `aiPicture` | `ai_Picture` | AI Picture Pro |
| `aiPicture` | `ai_Brightness` | AI Brightness |
| `aiPicture` | `ai_Genre` | AI Genre |
| `picture` | `superResolution` | Super Resolution |
| `sound` | `soundMode` | Sound Mode |
| `sound` | `aiSound` | AI Sound |
| `sound` | `clearVoice` | Clear Voice |
| `sound` | `aigamesound` | AI Game Sound |

```sh
wof settings list --json
```

```json
[
  {"category": "sound", "key": "aiSound", "label": "AI Sound", "value": "on", "values": ["on", "off"], "available": true, "context": {}}
]
```

`context` is the input/picture-mode scope the value belongs to (`{}` = global). `settings set`
re-reads the TV's current context, availability and allowed values first; it refuses a value the TV
does not currently allow or a setting whose scope changed since the list, so a value never lands in
the wrong scope. The new value is read back before success is reported.

```sh
wof settings set sound aiSound on
```

## wof notify

```
wof notify toast TEXT
wof notify say TEXT [--volume N]
```

* `toast`: message on the TV screen, 1-200 characters, no control characters.
* `say`: speaks through the TV speaker using the TV's Audio Guidance text-to-speech. It temporarily
  borrows Audio Guidance, speaker volume and mute and restores them afterwards. `--volume` is 1-40
  (default 15). It takes the TV-side lock, so it fails with "busy" while a processing job or another
  announcement runs (it waits up to 10 s). The TV must be on. Audibility was not confirmed by ear in
  the reference project.

```sh
wof notify toast "Dinner is ready"
# Toast shown on the TV
wof notify say "Dinner is ready" --volume 10
```

## wof overlay

```
wof overlay show [--title T] [--body T] [--line T ...] [--image URL]
                 [--kind info|success|warning|alert]
                 [--position top-left|top-right|bottom-left|bottom-right|center]
                 [--size xs|s|m|l|xl|full] [--seconds N]
wof overlay hide
```

Draws one card over whatever is on screen (including HDMI) through the installed overlay app
`dev.webosfoundry.overlay`; the foreground app does not change. These flags are the shorthand path:
title ≤ 80 characters, body ≤ 400, up to 10 `--line` values of ≤ 120, image an `http(s)` URL ≤ 500
(fetched by the TV, so it must be reachable from the TV), seconds an integer 0-300 (0 keeps the card
until `hide`, default 8), size defaults to `m`. At least a title, body, line or image is required;
unknown fields and control characters are refused, and nothing is launched while the TV is in
standby. The first card after a cold start takes about 2.5 s; later cards update in place. A remote
button press while a card is up dismisses it and is consumed.

```sh
wof overlay show --title Dinner --body "It is ready." --kind success --position top-right --seconds 10
# Overlay card shown
wof overlay hide
```

The CLI's shorthand flags compile into an equivalent JSON widget tree before it reaches the TV
(stack, row, text, image, badge, dot, progress, countdown, list, divider — depth ≤ 4, ≤ 40 widgets,
≤ 32768 bytes; full schema: [ARCHITECTURE.md §3a](../ARCHITECTURE.md)). The CLI has no flags for a
custom tree; build one with the web UI's Advanced builder, `curl`/`POST /api/overlay` with a `root`
field, or a scene's `overlay` step (`wof scene`, below).

## wof scene

```
wof scene list [--json]
wof scene set NAME FILE.json
wof scene delete NAME
wof scene run NAME
```

A scene is a named sequence of 1-20 steps, run in order, stopping at the first failure. `set` reads
`{"steps": [...]}` from `FILE.json` (`-` for stdin), validates it (an `overlay` step's card is
compiled into a widget tree at save time, the same as `wof overlay show`) and saves it; `run` prints
one line per completed step. A step is `{"type": "remote", "action", "value"?}` (same actions as
`wof remote`), `{"type": "setting", "category", "key", "value", "context"?}` (same settings as
`wof settings set`), `{"type": "overlay", "card"}` (same shape `POST /api/overlay` accepts), or
`{"type": "wait", "seconds": 0-10}`.

```sh
cat > movie-night.json <<'EOF'
{"steps": [
  {"type": "setting", "category": "sound", "key": "aiSound", "value": "off", "context": {}},
  {"type": "overlay", "card": {"title": "Movie night", "kind": "info", "seconds": 5}}
]}
EOF
wof scene set movie-night movie-night.json
wof scene run movie-night
```

## wof schedule

```
wof schedule list [--json]
wof schedule set [--id ID] SCENE HH:MM [--days mon,tue,...] [--disabled]
wof schedule delete ID
```

Runs a saved scene automatically at a time of day (the server's local clock), on the given days
(omit `--days` for every day). Needs `wof serve` (or the on-TV server) running continuously; a missed
time while the server was stopped is not caught up. Omit `--id` to create a new entry; pass it to
update an existing one.

```sh
wof schedule set movie-night 20:00 --days fri,sat
```

## wof webhook

```
wof webhook list [--json]
wof webhook create SCENE [--label TEXT]
wof webhook delete TOKEN
```

Mints a private URL (`/webhook/<token>`, no sign-in required) that runs one named scene — for
triggering from another app, a phone shortcut, or a smart-home routine. `create` prints the token and
the relative URL; prefix it with your server's address to get the full link. Delete the webhook to
revoke it; anyone holding the URL can run that scene until then.

```sh
wof webhook create movie-night --label "Movie night"
# token t0k3n...  url /webhook/t0k3n...
curl http://host:8765/webhook/t0k3n...
```

## wof connector

```
wof connector football [--league bl1] [--show]
```

Polls a built-in data source and prints the resulting overlay card as JSON; `--show` sends it to the
TV instead (same as `wof overlay show` with a `root` tree). `football` uses the free,
no-API-key [OpenLigaDB](https://api.openligadb.de/) API: up to 6 matches of the given league's
current matchday (default `bl1`, Bundesliga), each match's score or kickoff time if it has not
started yet. No API key, no TV pairing needed to preview (pairing is only needed for `--show`).

```sh
wof connector football --league bl1 --show
```

## wof screenshot

```
wof screenshot OUT.jpg [--width N] [--format jpg|png]
```

Captures the HDMI picture (without the TV's own menus) into `OUT.jpg`. Width defaults to 1920
(allowed 64-3840, even; the height follows the 16:9 picture); format is `jpg` or `png`. Copy-protected
(HDCP) sources cannot be captured. **The picture is whatever the connected device displays; treat
it as private.** The TV-side file is deleted in the same SSH command.

```sh
wof screenshot /tmp/tv.jpg --width 960
```

## wof stream

```
wof stream --bench SECONDS [--size WxH] [--fps N] [--png OUT.png]
```

Benchmarks the native fast-capture client (`vtcap`): requests frames of `--size` (default `160x90`;
the reference validated 160x90, 320x180 and larger) at `--fps` for `SECONDS` and reports what was
delivered; `--png` saves the last frame. Requires `wof install --vtcap yes` with a locally built
client. The native client's stdout is the 4 bytes `C5F1` (magic inherited from the reference client),
`u16le width`, `u16le height`, then raw RGB24 frames; `webos_foundry` parses that and the HTTP route
`GET /api/screen/stream` re-emits the frames with its own `WOF1` header ([API.md](API.md)).

Reference measurements (one OLED C-series TV, HDMI 1 at 3840×2160 @ 120 Hz, 8 s each, 160×90):
30.4 fps at `--fps 30` and 60.1 fps at `--fps 60`; the driver maximum is 60 fps. These are the
reference project's numbers, not a guarantee for your TV.

```sh
wof stream --bench 8 --size 160x90 --fps 30 --png /tmp/frame.png
```

## wof process

```
wof process image IN OUT [--profile X]
wof process audio IN OUT [--profile X]
```

Sends a file through the TV's own AI picture or sound pipeline and writes the result.

| Operation / profile | TV settings |
| --- | --- |
| Image `ai-picture` | AI Picture Pro on, Super Resolution off |
| Image `ai-picture-sr` (default) | AI Picture Pro on, Super Resolution high |
| Audio `ai-sound` (default) | `soundMode=aiSoundPlus`, `aiSound=on` |
| Audio `clear-voice` | `soundMode=voiceEnhance`, `clearVoice=level3` |
| Either `standard` | Baseline with the corresponding enhancement settings off |

* Image input: 8-bit PNG/JPEG, 16:9 with even dimensions up to 1920×1080, at most 16 MiB; the
  output is a 3840×2160 PNG captured from the TV's video plane. The image is shown on screen while it
  processes, and `ffmpeg`/`ffprobe` must exist on the host.
* Audio input: stereo 48 kHz signed 16-bit PCM WAV, 1-30 s, at most 8 MiB, not silent; HDMI 4 must be
  disconnected. Output is a peak-normalized 32-bit WAV; capture precision is low.
* One job at a time (a TV-side lock); the TV restores its picture/sound state before the output is
  published, and existing output files are never overwritten.
* This proves changed pixels/PCM versus a baseline, not perceptual improvement; no custom neural
  model is run (`neural_subalgorithm_verified` is false in the reference).

```sh
wof process image source.png processed-4k.png --profile ai-picture-sr
wof process audio speech.wav processed-voice.wav --profile clear-voice
```

## wof serve

```
wof serve [--host 127.0.0.1] [--port 8765] [--token TOKEN] [--generate-token]
```

Starts the HTTP API and web UI. `--token` overrides the config's `server_token` for this run;
`--generate-token` prints a new random token and exits (it does not start the server or save
anything); set it with `wof config set server_token TOKEN` or pass `--token TOKEN` at serve time.
On a non-loopback `--host` the server refuses to start without a token.

```sh
wof serve --host 0.0.0.0 --token "$TOKEN"
```

## wof config

```
wof config show
wof config set KEY VALUE
```

Keys are the config fields in `config.json` (mode 0600): `tv_host`, `ssh_port`, `key_path`,
`known_hosts_path`, `mac`, `broadcast`, `server_token`.

```sh
wof config set mac AA:BB:CC:DD:EE:FF
wof config set broadcast 192.168.1.255:9
```

`key_path` and `known_hosts_path` point at files `wof pair` created; they are never your root key.
