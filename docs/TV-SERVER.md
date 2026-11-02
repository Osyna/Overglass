# On-TV server (`tv-server/`)

A second way to reach the same web UI and HTTP API: a small Node server that runs **on the TV itself**,
so a phone or laptop on the LAN can open `http://<tv-ip>:8766/` with no PC, no SSH key and no `wof`
install on the controlling device. Pair the TV once from a PC (`wof pair`, `wof install --tv-server`),
then anyone on the LAN who has the token can use it.

## First thing to check: is the TV's TCP port reachable? (unverified)

**Binding a real LAN-reachable TCP socket from this boot context has never been tested on this TV.**
Nothing in this project's findings confirms or denies that a root-context
`node http.createServer().listen(8766, '0.0.0.0')` can accept connections from the LAN on this TV's
kernel and network namespace. The proven precedents are a Unix-domain LS2 service and an SSH-piped
binary, not a TV-opened TCP listener. Everything below is built and tested offline against a fake
dispatcher on loopback; none of it has touched a TV.

Run this one line first, from **another device on the LAN** (not from the TV):

```sh
curl -s http://<tv-ip>:8766/api
```

* **Success** is a JSON document starting `{"tv":{"address":"127.0.0.1"},"base":"http://<tv-ip>:8766",...`
  (the catalogue, which needs no token). The listener works; open `http://<tv-ip>:8766/` in a browser.
* **Failure** (connection refused, timeout, no route) means **the TCP bind or the network path itself
  failed on this TV, not a bug in this code**: this server's own routes are covered by the offline
  tests. Narrow it down over SSH before suspecting the code: `tail /tmp/webos-foundry-tv-server.log`
  (does it say `listening on 0.0.0.0:8766`, or `cannot listen ...`?), and
  `cat /tmp/webos-foundry-tv-server.pid` plus `ls /proc/$(cat /tmp/webos-foundry-tv-server.pid)` (is the
  process alive?). Listening in the log but unreachable from the LAN points at the TV's firewall or
  network namespace; `cannot listen` points at the bind itself (try another port with `WOF_TV_PORT`
  set in the hook's environment). Use the PC-hosted server (`wof serve`) in the meantime: it needs
  none of this.

## How it differs from the PC-hosted server (`wof serve`)

| | PC-hosted (`wof serve`) | On-TV (`tv-server/server.js`) |
| --- | --- | --- |
| Runs on | your computer | the TV |
| Reaches the TV | SSH with the dedicated restricted key, one `dispatch.sh` request per command | `sh dispatch.sh` locally, request in `$SSH_ORIGINAL_COMMAND` (the same request strings, the same regex wall) |
| Web UI | `web/` | the same files (copied to the TV at install time); the UI tells the two apart only by what `GET /api` lists |
| Port | 8765 | 8766 (so both can coexist on one LAN) |
| Auth | token (`wof config`), optional on loopback | its **own** token and `auth_mode` in `tv-server/config.json`, independent of the PC's; always required on a token-mode request (it listens on the LAN) |
| File processing (`/api/jobs*`) | yes | **no** (see below) |
| Wake from standby | Wake-on-LAN from the PC | **no** (the TV cannot send itself a packet; `POST /api/remote/wake` answers 501) |
| Install an app by uploading an IPK | yes (`POST /api/apps`, non-JSON body) | **no** (415): send `{"url", "sha256"?}` and the TV downloads it itself |
| Dependencies | Python | Node only, no `node_modules`; the reference TV reports Node 16.20.2 |
| Saved themes/history/bindings, external connectors, PIN accounts and pushed state | yes | PC-server features; use `wof serve` for these routes |

### Scope cut: no `/api/jobs`

AI picture and sound file processing is **not implemented** in TV-server mode. The host-side pre/post
processing in `process.py` was built and tested against a workstation's `ffmpeg`; porting that exact
pipeline into dependency-free Node is out of scope for this round. `GET /api` states this: it has no
Processing group and no `/api/jobs` route, its own entry has a `notes` field saying so, and the
catalogue has a top-level `unavailable` list naming the group. A UI that greys out whatever groups
`GET /api` does not list therefore greys the Processing panel out by itself. The PC-hosted server
keeps all of the feature.

## Install

From a PC already paired with the TV:

```sh
wof install --tv-server
```

This pushes `tv-server/server.js` and the web UI (`web/`) to
`/var/lib/webosbrew/webos-foundry/tv-server/`, `tv-server/init.d-hook.sh` to
`/var/lib/webosbrew/init.d/webos-foundry-tv-server` (mode 755), and runs the hook once. `config.json`
is never pushed: the server creates it on first start.

Layout on the TV:

| Path | What |
| --- | --- |
| `/var/lib/webosbrew/webos-foundry/dispatch.sh` | the dispatcher the server calls (installed by `wof pair` / `wof install`) |
| `/var/lib/webosbrew/webos-foundry/tv-server/server.js` | the server |
| `/var/lib/webosbrew/webos-foundry/tv-server/web/` | static root: any regular file under it is served (no `..`, no symlink out) |
| `/var/lib/webosbrew/webos-foundry/tv-server/config.json` | `{"token": "...", "auth_mode": "token"}`, mode 0600, created on first start |
| `/var/lib/webosbrew/init.d/webos-foundry-tv-server` | boot hook |
| `/tmp/webos-foundry-tv-server.log` | server log (tmpfs, gone at reboot; mode 0600) |
| `/tmp/webos-foundry-tv-server.pid` | pid written by the hook |

### The boot hook

`init.d-hook.sh` is a POSIX `sh` script, executable, in the `/var/lib/webosbrew/init.d/` style
(webosbrew runs each script there as root at boot):

```sh
sh /var/lib/webosbrew/init.d/webos-foundry-tv-server [start|stop]
```

* `start` (the default with no argument) is **re-entrant**: it first stops the server it started
  before, then starts a fresh detached one (`setsid node .../server.js`, output appended to the log),
  writes the pid file, waits one second and exits 1 with a message if node already died.
* `stop` kills it and removes the pid file; with no server running it is a no-op.
* It only ever kills a process whose command line contains its own `.../tv-server/server.js`, so a
  stale pid file whose number was reused by something else is ignored, never killed.

## Auth and first boot

* On first start with no `config.json` the server generates a random 256-bit token, writes the file
  (mode 0600), and logs the token **once**, to `/tmp/webos-foundry-tv-server.log` only (never stdout).
  Read it over SSH, e.g. `cat /var/lib/webosbrew/webos-foundry/tv-server/config.json`, and paste it
  into the web UI; API clients send `Authorization: Bearer <token>`.
* While there is no usable token (the config cannot be written, was deleted, or is invalid, for
  example an unknown `auth_mode`) the server fails closed: `GET /` serves only a plain, unauthenticated
  notice page, "No token set yet: see the log at /tmp/webos-foundry-tv-server.log or run
  `wof config show` from a paired PC", and every other path answers 503. The control UI is never
  served without a token behind it.
* `GET /api` and `GET /api/health` and the static UI files never need the token; everything else does.
* `auth_mode: "disabled"` (set with `PATCH /api/config/auth {"mode": "disabled", "confirm": true}`, or
  by editing `config.json`) makes **no** route require the token, ever. Anyone on the LAN can then
  control the TV, read what its HDMI input shows and install apps. It is an explicit risk for a trusted
  network; `GET /api/config/auth` reports `{"mode": "disabled", "note": "..."}` so the UI can show its persistent
  warning. Switch back with `{"mode": "token", "confirm": true}`; the token is kept.
* Cross-site browser writes are refused (a non-GET request whose `Origin` is not the page's own host,
  or `Sec-Fetch-Site: cross-site`, gets 403).

## Routes

Same shapes as `webos_foundry/server.py` (see [API.md](API.md)): `/api`, `/api/health`, `/api/status`,
`/api/details`, `/api/notify/toast`, `/api/notify/say`, `/api/overlay`, `/api/screenshot`,
`/api/screen/stream`, `/api/remote/{action}`, `/api/settings` (GET) and
`/api/settings/{category}/{key}` (PUT), `/api/apps` (GET, POST), `/api/apps/{id}` (DELETE),
`/api/config/auth` (GET, PATCH). `/api/health` always answers `{"paired": true, "tv_host": "127.0.0.1"}`.
`GET /api/apps` returns a bare array; `POST` and `DELETE` return `{"message": ...}`.

Every handler builds the exact request string `dispatch.sh` validates (ported from
`webos_foundry/dispatcher.py`), validates its input first as the Python side does, and runs
`sh dispatch.sh` as a child process with the request in `SSH_ORIGINAL_COMMAND`. TV commands that
change state (remote, settings, say, apps) are serialized by one lock in the server, on top of the
TV-side `flock`. Errors are `{"error": "..."}`: 400 bad input, 401 token, 409 TV busy, 501 an action
this server does not have, 502 the TV refused or its reply was malformed.

## Tests

`python3 -m pytest tests/test_tv_server.py` (Node-driven, run from pytest; needs `node` and `sh`).
It starts the real `server.js` on `127.0.0.1:0` with `WOF_TV_DISPATCH` pointing at a tiny shell script that
fakes each `dispatch.sh` verb, and covers every route's shape, token/disabled auth, the first-boot token
and notice page, static serving and traversal, the absence of `/api/jobs` in the catalogue, that
every request string passes `dispatcher.GRAMMAR`, status parsing parity with `tv.parse_status`, stream
teardown, and the boot hook (with a shim `node`). It never opens a connection to a TV.

The `WOF_TV_*` environment variables (`DISPATCH`, `WEB`, `CONFIG`, `LOG`, `HOST`, `PORT`) exist only so
these tests can redirect the install paths; the TV sets none of them and uses the constants at the top
of `server.js`.

## Not verified on a TV

Besides the TCP bind above: the Node version on the TV (the code avoids syntax newer than the TV's
other Node scripts use), that `setsid`/`tr` behave as in the test host's `sh` under the boot hook's
environment, that `/proc/<pid>/cmdline` shows the absolute `server.js` path there, and the on-TV Homebrew
app verbs (`app-list`, `app-install`, `app-uninstall`) which are owned by `tv-assets/apps.js`.
