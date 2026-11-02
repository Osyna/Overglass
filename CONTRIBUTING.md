# Contributing

Thanks for helping. Most changes need **no TV**: the whole test suite runs offline.

## Setup and tests

```sh
git clone https://github.com/webos-foundry/webos-foundry
cd webos-foundry
pip install -e . pytest
pytest
```

* Every test uses a `FakeTransport` or mocked HTTP; nothing opens a socket to a TV. Do not add tests
  that need a real TV.
* The core (`webos_foundry/`) is standard library only. Do not add required dependencies.
* TV-side scripts: `node --check tv-assets/*.js` and `sh -n tv-assets/*.sh` are the offline syntax checks.
* The Home Assistant integration talks only to the HTTP API (no SSH) and may use `aiohttp`, already a
  Home Assistant core dependency.

## Ground rules

* [ARCHITECTURE.md](ARCHITECTURE.md) is the contract (config schema, dispatcher grammar, function
  signatures, HTTP routes). If you need something it does not define, add it there first, additively.
  Changing the dispatcher grammar means updating `tv-assets/dispatch.sh`, `dispatcher.py`, the tests and
  [docs/SAFETY.md](docs/SAFETY.md) together.
* The restricted key must stay restricted: do not add dispatcher verbs that run arbitrary commands, read
  or write arbitrary files, or reach destructive Luna methods (erase, firmware, Pixel Refresher
  setters, usage reset, `/proc/lg/*`).
* Only add features that are grounded in something proven on a TV or in the existing project. Findings
  go in [docs/FINDINGS.md](docs/FINDINGS.md) with the measurement and the hardware, no invented numbers.
* After changing HTTP routes, run `python scripts/gen_api_docs.py` to regenerate the route table in
  `docs/API.md`.
* Never include real tokens, IP addresses, MAC addresses, serial numbers or keys in code, tests, docs or
  issues. Use placeholders such as `192.168.1.50` and `AA:BB:CC:DD:EE:FF`.

## Pull requests

Small, focused changes with a test where there is logic. Describe what you ran. If you tested on real
hardware, say which model and webOS version, and what you did **not** test.

By contributing you agree that your contribution is licensed under the MIT license.
