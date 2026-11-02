# Security policy

## Reporting a vulnerability

There is no private maintainer mailbox. Open an issue at
<https://github.com/webos-foundry/webos-foundry/issues> describing the problem.

**Do not post real tokens, private keys, IP or MAC addresses, `config.json` contents, screenshots from
your TV, or full logs in an issue.** Redact them, or describe how to reproduce with placeholders. If a
report needs a secret to be understood, say so without including it and a maintainer will suggest a
safe way to share it.

## What is in scope

* The dispatcher grammar (`tv-assets/dispatch.sh`, `webos_foundry/dispatcher.py`): any input that is
  accepted but runs something outside the documented verbs, or reaches a Luna method the project says it
  never calls.
* The restricted SSH key setup written by `wof pair`.
* The HTTP API: authentication bypass, token leakage, DNS-rebinding or cross-origin write protections.
* The Home Assistant integration handling of the token.

## Threat model in short

* The user's root key is used once at pair time and never stored.
* The dedicated key is limited to a fixed command grammar ([docs/SAFETY.md](docs/SAFETY.md)).
* The HTTP API is loopback-only by default; non-loopback binds require a bearer token, which is sent in
  cleartext over plain HTTP. Put TLS in front of it on untrusted networks.
* Out of scope: vulnerabilities in LG's webOS, in rooting exploits, or anything that needs an
  already-compromised root key.

## Supported versions

Only the latest release receives fixes.
