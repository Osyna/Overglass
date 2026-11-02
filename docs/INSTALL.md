# Installation

Overglass controls an LG webOS TV that is **already rooted**. It does not root the TV, does
not need an LG account and never asks for one.

## Prerequisites

| Requirement | Why |
| --- | --- |
| A rooted webOS TV with the Homebrew Channel / webosbrew installed and SSH enabled as `root` | See <https://www.webosbrew.org/>. Rooting is out of scope here; tools such as slopbro or dejavuln-autoroot are examples of what people use, but Overglass neither bundles nor depends on any of them. |
| The key (or password-less access) you already use to SSH in as `root` | Used **once**, by `wof pair`. It is never stored. |
| `ssh` and `ssh-keygen` on the machine running `wof` | `wof` shells out to the system `ssh`; the stdlib cannot generate SSH keys, so `ssh-keygen` is required by `wof pair` (checked by `wof doctor`). |
| Python 3.9 or newer | The package has no required Python dependencies. |
| Optional: `clang` + `lld` | Only to build the native fast-capture client (`tv-assets/vtcap/build.sh`) for `wof stream`. |
| Optional: `ffmpeg` / `ffprobe` on the host | Needed by `wof process image` (the reference pipeline encodes a static H.264 clip). |
| Optional: a Home Assistant instance | See [HOME-ASSISTANT.md](HOME-ASSISTANT.md). |

Node.js is used by the TV-side scripts only; webOS ships it, you do not install it.

The TV must be on the same network as the machine running `wof`, and must keep SSH reachable in
normal standby if you want `wof status` to work while it is off. `wof remote wake` sends a
Wake-on-LAN packet and needs the TV's MAC address (`wof config set mac AA:BB:CC:DD:EE:FF`).

## Install from source

Use a checkout or extracted copy of this repository. The CLI and web server read
`web/` and `tv-assets/` from it, so keep the checkout available. From its root:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .
wof --help
```

This provides the `wof` command. Configuration lives in `~/.config/webos-foundry/config.json`
(override with `WEBOS_FOUNDRY_HOME` or `--config-dir`).

## First run: pair, install, check, serve

### 1. Pair

Use the key you already have from rooting the TV:

```sh
wof pair --host 192.168.1.50 --root-key ~/.ssh/tv_root_key
```

(Or skip this and the "serve" step below in that order: run `wof serve` first, open the page, and
pair from the "Let's connect your TV" card — `POST /api/pair` does the same thing, loopback only.)

`wof pair` (see [ARCHITECTURE.md §6](../ARCHITECTURE.md)):

1. connects once with your root key and pins the TV's host key in `<config dir>/known_hosts`
   (the only connection that trusts a host key on first use);
2. generates a fresh ed25519 key pair `<config dir>/id_ed25519`;
3. pushes the dispatcher to `/var/lib/webosbrew/webos-foundry/dispatch.sh`;
4. **appends** one restricted line to `/home/root/.ssh/authorized_keys` (your existing key keeps
   working; nothing is overwritten);
5. saves the config, then reconnects with the new restricted key and runs `wof install`.

Your root key's path and contents are never written to the config or to logs. See
[SAFETY.md](SAFETY.md) for exactly what the restricted key may do.

### 2. Install / verify

`wof pair` already ran an install. Run it again any time (for instance after upgrading the Python
package, use `wof update` to refresh only the TV scripts):

```sh
wof install              # scripts, overlay app, native capture client if built
wof install --no-overlay # skip the overlay app
wof install --vtcap yes  # fail if the native client is not built; `no` skips it, `auto` (default) installs it only if built
wof update               # re-push the TV-side scripts only
```

To enable `wof stream`, build the native client first (it cross-compiles against the TV's own
`libc`; see `tv-assets/vtcap/build.sh` for the inputs it needs), then `wof install --vtcap yes`.

#### One-click installation of the included TV app

With the web UI running and the TV connected, open **Apps → Included with Overglass**.
The overlay renderer (`dev.webosfoundry.overlay`) has an **Install on TV** button when missing
and a **Repair** button when installed. No external package URL or manual IPK build is needed.
The installer waits for the TV's installed state and checks installation status before reporting success.

The PC-hosted server builds the IPK from this checkout. `wof install --tv-server` also stages
a private copy for the on-TV server, so that server can install or repair the renderer without a PC.
If its package is unavailable, update the on-TV installation from a checkout with that command.
Other apps still use the existing file/link installer and uninstall confirmation.

### 3. Doctor

```sh
wof doctor
```

`wof doctor` checks that `ssh`/`ssh-keygen` exist, that the config loads, that the TV answers
over the restricted key, and what is currently installed on the TV, and reports anything missing.

### 4. Serve the HTTP API and web UI

```sh
wof serve --generate-token          # prints a token and exits; it does not save or start serving
wof config set server_token "$TOKEN" # persist it, or pass --token "$TOKEN" below each time
wof serve                            # http://127.0.0.1:8765/
wof serve --host 0.0.0.0 --token "$TOKEN"   # reachable from another machine, e.g. Home Assistant
```

* On `127.0.0.1`/`::1` the token is optional but still accepted.
* On any other bind address the server **refuses to start** without a token (in the config or via
  `--token`), and every API route requires `Authorization: Bearer <token>`.
* Open the web UI at `http://<host>:8765/`; it asks for the token once and keeps it in
  `localStorage`.

See [API.md](API.md) for routes and [CLI.md](CLI.md) for every command.

## Docker

The image (`Dockerfile`) is `python:3.12-slim` plus `openssh-client`, with the package installed
editable from the source tree (the server and CLI read `web/` and `tv-assets/` from it). Its
entrypoint is `wof`, its default command is `serve --host 0.0.0.0`, and it runs as uid 1000 with
`WEBOS_FOUNDRY_HOME=/config`. `docker-compose.yml` publishes port `8765` and keeps `/config` in a named
volume so pairing survives restarts.

Pair with the CLI before starting the LAN-facing container server; browser pairing requires
a loopback-bound server. Mount the root key read-only for that one command only:

```sh
docker compose build
docker compose run --rm -v ~/.ssh/tv_root_key:/root-key/tv_root_key:ro webos-foundry \
    pair --host 192.168.1.50 --root-key /root-key/tv_root_key
WOF_TOKEN=$(docker compose run --rm webos-foundry serve --generate-token)   # prints a token and exits; does not save or serve
docker compose run --rm webos-foundry config set server_token "$WOF_TOKEN"
docker compose up -d
```

(The key must be readable by uid 1000 and not group/world-readable, or `ssh` refuses it.) The server in
the container binds `0.0.0.0`, so it needs a token: either the `server_token` saved above, or uncomment
the `command:` line in `docker-compose.yml` to pass `--token "$WOF_TOKEN"`. There is no environment
variable for the token inside the container; `WOF_TOKEN` is only compose variable substitution.

## systemd

Install the package system-wide first from a checkout (`sudo pip install -e .`; editable because the
server and CLI read `web/` and `tv-assets/` from the source tree, so keep the checkout readable by
the `webos-foundry` user and outside `/home`, which the unit hides with `ProtectHome=true`) so it can run `wof`; the unit sets
`WEBOS_FOUNDRY_HOME=/var/lib/webos-foundry/config`.

`systemd/webos-foundry.service` runs `wof serve` as a dedicated `webos-foundry` user:

```sh
sudo useradd --system --create-home --home-dir /var/lib/webos-foundry webos-foundry
sudo -u webos-foundry env WEBOS_FOUNDRY_HOME=/var/lib/webos-foundry/config \
    wof pair --host 192.168.1.50 --root-key /path/to/root_key
sudo -u webos-foundry env WEBOS_FOUNDRY_HOME=/var/lib/webos-foundry/config wof serve --generate-token  # prints a token and exits
sudo -u webos-foundry env WEBOS_FOUNDRY_HOME=/var/lib/webos-foundry/config wof config set server_token TOKEN  # paste the printed token
sudo cp systemd/webos-foundry.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now webos-foundry
```

Adjust the `ExecStart` path to wherever `pip` put `wof` (`command -v wof`) and the `--host` flag
to your needs.

## Troubleshooting

**`wof pair` fails to connect.** Confirm `ssh -i ~/.ssh/tv_root_key root@192.168.1.50` works by
hand first. The TV's SSH server only accepts the key after rooting finished; if you rooted with a
password-less method make sure the key you pass is the one authorised in
`/home/root/.ssh/authorized_keys`. The TV must be on (not just standby) during pairing.

**`Host key verification failed` after pairing.** The TV was factory-reset or re-rooted and its host
key changed. Delete `known_hosts` in the config directory and run `wof pair` again; do not disable
`StrictHostKeyChecking`.

**The dispatcher rejects a command.** The TV-side `dispatch.sh` only accepts the exact grammar in
[ARCHITECTURE.md §3](../ARCHITECTURE.md); a rejected command means the script on the TV is older
or different from the installed Python package. Run `wof update` (re-pushes the scripts through
the restricted key), then `wof doctor`. If it still rejects a verb the package sends, open an
issue with the package version and the (redacted) error.

**`401` from the API / the HA integration says "invalid token".** The server is bound to a
non-loopback address and the `Authorization: Bearer <token>` header is missing or wrong. Compare
`wof config show` (token is masked) on the server host with the token you gave the client.
`GET /api/health` needs no token and is the quickest reachability check.

**Another host cannot reach the server.** `wof serve` defaults to `127.0.0.1`. Use
`--host 0.0.0.0` (with a token) or put a reverse proxy in front.

**`wof remote wake` says the MAC is unset.** `wof config set mac AA:BB:CC:DD:EE:FF` (and
`broadcast`, default shape `192.168.1.255:9`, if your subnet differs).

**409 from the API.** The TV is reserved by an image/audio processing job or by a `say`
announcement; retry when `GET /api/jobs` shows no active job.

## Uninstall

`wof uninstall` removes everything it installed on the TV **except** the restricted
`authorized_keys` line. Read [SAFETY.md](SAFETY.md) for why, and how to remove that line by hand.
