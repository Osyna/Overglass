# Safety and privacy

Overglass is for a TV **you own and have already rooted**. A rooted TV gives whoever holds root
every Luna service on the device, including ones that can erase data or damage the panel. The design
goal here is that day-to-day control uses a key that can do only a short, fixed list of things.

## Least-privilege design

* **The root key is used once.** `wof pair` connects with the key you already have, to bootstrap.
  It is never copied, stored or logged; its path is not written to the config.
* **A dedicated restricted key is used afterwards.** `wof pair` generates a fresh ed25519 key in the
  config directory and appends one line to `/home/root/.ssh/authorized_keys` (existing keys keep
  working, nothing is overwritten):

  ```
  command="sh /var/lib/webosbrew/webos-foundry/dispatch.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,restrict ssh-ed25519 AAAA... wof@<local hostname>
  ```

  * `command=` forces every login through `dispatch.sh`. The client's requested command arrives only
    as the `SSH_ORIGINAL_COMMAND` string; it is matched against a fixed grammar and never `eval`'d.
  * `no-port-forwarding`, `no-agent-forwarding`, `no-X11-forwarding`, `no-pty` and `restrict`
    deny forwarding, agent/X11 access and a terminal.
* **Host key pinning.** The TV's host key is pinned once during `wof pair` (the only connection that
  uses `StrictHostKeyChecking=accept-new`); every later connection uses `StrictHostKeyChecking=yes`
  against the pinned `known_hosts` with `IdentitiesOnly=yes` and `BatchMode=yes`.
* **Validation twice.** The Python side validates every argument first; the dispatcher validates
  again (base64 charset, integer ranges, verb regexes), so a compromised client still cannot get
  past the grammar.

## What the dispatcher will never do

The full grammar is [ARCHITECTURE.md §3](../ARCHITECTURE.md). Verbs that exist: `status`,
`details`, `remote`, `settings-list`, `settings-set`, `notify-toast`, `notify-say`,
`notify-overlay`, `screenshot`, `stream-start`, `process-image`, `process-audio`, `idle-wait`,
`install`, `install-overlay`, `uninstall-overlay`, `install-vtcap`, `uninstall-vtcap`,
`uninstall-all`. Consequently:

* **There is no verb for** erasing or factory-resetting data, firmware or `micomservice` power
  commands, triggering the OLED Pixel Refresher or any other `oledepl` setter, resetting usage
  statistics, writing `/proc/lg/*` PWM or thermal values, LG account or ThinQ operations, pairing or
  commissioning (Matter, Bluetooth), or arbitrary shell, file read or file write.
* `settings-set` is further limited by an allow-list: only the eight settings in
  [CLI.md](CLI.md#wof-settings) can be read or written, and the value is checked against what the TV
  currently allows, in the scope (context) the TV reports.
* `install` writes only the named files from a fixed whitelist under
  `/var/lib/webosbrew/webos-foundry/`, atomically (`.new` then `mv`).
* Read-only sensors (`details`) call getters only; the reference never calls pixel-refresher setters
  or the usage `reset`.

The root key you used to root the TV is still fully powerful. Overglass's restricted key does not
change that; it only stops *this tool's* credential from being a root shell.

## What `wof uninstall` does and does not remove

`wof uninstall` sends the `uninstall-all` verb. It removes:

* every file under `/var/lib/webosbrew/webos-foundry/`;
* the overlay app `dev.webosfoundry.overlay`;
* the vtcap role/manifest and binary (only the files `install-vtcap` created);
* finally `dispatch.sh` itself.

It **does not** remove the `authorized_keys` line. `dispatch.sh` is the forced command sshd is running
for the current session; deleting that line from inside it would mean editing the very file sshd is
reading its forced command from, with a race. Instead the line is **printed for you to delete by
hand** with your root key:

```sh
ssh -i ~/.ssh/tv_root_key root@192.168.1.50 \
  "sed -i '/wof@/d' /home/root/.ssh/authorized_keys"      # review the line first; this matches the wof comment
```

After that, delete the local config directory (`~/.config/webos-foundry`) if you want to drop the
private key and config. Until the `authorized_keys` line is removed, the key remains authorised, but
with `dispatch.sh` gone it can no longer run anything useful.

## Privacy

* **Screenshots and the live view show whatever the connected HDMI device is displaying**: desktop,
  documents, messages, a game. `GET /api/screenshot`, `GET /api/screen/stream`, `wof screenshot` and
  `wof stream` all expose that. The server stores no frames and the TV-side screenshot file is deleted
  in the same SSH command, but the response itself is the full picture. Treat it as private.
* **Image/audio processing** puts the input on the TV's screen / through its speakers while it runs,
  and uploads/results live in a private temporary directory that is deleted when the server stops.
* **The HTTP API controls your TV.** Anyone who can reach the port (and has the token on a
  non-loopback bind) can change the volume, show cards, read screenshots and speak through the TV.
  Prefer binding to loopback or a trusted LAN segment, keep the token secret, and do not expose the
  port to the Internet. Browser requests from other sites are refused by Host/Origin checks, but
  `curl` and scripts are not subject to them.
* `config.json` (mode 0600) holds the TV's address, MAC and the server token; do not post it. The
  bearer token travels in cleartext over plain HTTP: put TLS in front (a reverse proxy) if the network
  is not trusted.
* `say` borrows Audio Guidance, speaker volume and mute and restores them, with read-back, under the
  TV-side lock. Restoration after a killed connection or power loss was not tested; check the TV's
  volume and Audio Guidance setting if it sounds different afterwards.
* Not tested: behaviour on other TV models/firmware, loss of power or network during processing.

## PIN accounts and data sources

PIN accounts have admin or remote-only guest roles. Guest requests cannot read screenshots, designs,
settings, account lists or the event feed. Their default remote allowlist excludes wake and power-off.
An owner can explicitly change that list. PIN hashes use salted scrypt; sessions expire after eight
hours and account changes revoke them. Login attempts are limited per address and account. A supplied
invalid credential is rejected even on loopback or when owner login is disabled.

PINs and bearer tokens travel in cleartext over HTTP. Use HTTPS on an untrusted network. Do not put
tokens in event-stream URLs; the browser uses authenticated fetch with an Authorization header.

JSON, Home Assistant, feed and lineup URLs make HTTP requests from the server. Public-network
addresses are the default. Private/LAN sources require explicit opt-in. DNS results are checked and
connections pinned, redirects are checked again, and credentials are removed on cross-origin
redirects. Requests have time and body-size limits. Do not enable private access for a URL you do not
trust.

Design bindings change existing display scalars only. SVG accepts a restricted geometry subset;
scripts, entities, external resources and embedded HTML are refused. Sharing exports remove bearer
tokens and recognized credential-like URL parameters and mark missing secrets. Review exported
content before publishing; arbitrary private text or secret path components cannot be identified
automatically.

HDMI preview backgrounds are opt-in captured frames. Clear them when finished; they can contain
private information from the connected device. Ambient dim changes only the overlay opacity. It
does not write picture settings, OLED controls or hardware brightness registers.

Webhook migration: GET now describes a capability, while POST executes it. A design webhook can fill
only declared binding targets or existing placeholders. Keep capability URLs private and delete them
to revoke access.
