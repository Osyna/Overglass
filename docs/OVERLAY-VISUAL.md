# Overlay pixel references

`web/check-visual.mjs` captures the production `tv-assets/overlay/index.html` renderer through Chrome DevTools Protocol (CDP). The 27 cards in `web/visual-references/cases.json` cover widget families, local images/fonts, edge regions, themes, offsets, the first timeline card, and compact/dim rendering.

Prerequisites: Node 22 or newer (built-in WebSocket), Chromium, Python 3, and Pillow (`python3 -m pip install Pillow` in your development environment). These are development tools; the TV and server need no new dependencies. Use the same Chromium version and OS image for reference capture and comparison. The reference manifest records the browser version.

From the repository root:

```sh
# Normal regression check; never changes reference files.
node web/check-visual.mjs --chromium /usr/bin/chromium --output /tmp/overlay-visual

# Explicitly capture replacement references after an intentional visual change.
node web/check-visual.mjs --update-references --chromium /usr/bin/chromium --output /tmp/overlay-review
```

Review every replacement PNG, then commit `web/visual-references/*.png` and `manifest.json` together. Capture alone does not approve a new appearance. Missing references fail the normal check; it never creates or blesses them automatically. `--references DIR` selects a separate reference set, for example one captured on a particular TV firmware. `--python PATH` selects the Python interpreter. `CHROMIUM` and `PYTHON` environment variables supply executable defaults.

The viewport is 1920 by 1080 at device scale 1, locale en-US, timezone UTC, and a fixed opaque `#101820` backdrop. A preload freezes `Date` at `2026-01-15T12:34:56Z` before application scripts execute. CSS animation and transitions are disabled, while production geometry, styles, bundled fonts, and QR code rendering remain intact. The capture waits for fonts, images, and two animation frames. It rejects missing widget/card DOM, unloaded bundled fonts, unexpected viewport/time, and browser exceptions.

Comparison decodes PNG pixels with Pillow, including alpha. The tolerance is zero changed pixels and zero channel delta. Failures produce actual PNGs, red-highlighted `.diff.png` images, and `report.json`; success exits 0 and any mismatch exits 1. Browser/font rasterizer changes can require reviewed replacement references. Keep CI's browser image pinned rather than increasing tolerance to hide differences.

Every run also inserts a visible magenta 1-by-1 CSS pixel into the actual browser page, captures it, and requires exactly one screenshot pixel to change. That image must fail the same comparator both against the unmodified capture and against the first stored reference. This negative control uses rendered screenshots, not synthetic identical buffers. It cannot silently pass a comparator that ignores changed pixels.

Before capture, `tests/overlay-runtime.js` runs in the production page and checks DOM/focus preservation, removed fields, safe SVG, encoded QR modules, runtime state, and timeline advancement/cancellation with controlled lifecycle timers. Its result appears in `report.json`. Timeline pixel coverage captures the first card; animation appearance and TV compositor/input pass-through need separate hardware checks.

## Optional TV CDP capture

Enable the TV's developer inspector and launch the overlay app first. `--cdp` accepts an HTTP debugging endpoint exposing `/json/list`, or a page WebSocket URL. HTTP discovery prefers the page matching `--url`, otherwise the first page. Use a dedicated inspector endpoint: the selected page is navigated to `--url` for every fixture, and its live content is replaced.

If the TV can reach the development machine at `192.168.1.20`, serve the real overlay and deterministic image fixture from that machine:

```sh
node web/check-visual.mjs \
  --cdp http://192.168.1.50:9998 \
  --host 0.0.0.0 --port 8127 \
  --url http://192.168.1.20:8127/overlay/index.html \
  --references /tmp/tv-firmware-references \
  --update-references --output /tmp/tv-review
```

Remove `--update-references` to compare that TV against its reviewed reference set. Keep the endpoint and fixture server on a trusted LAN; CDP has control of the inspected page. The script does not install/launch the TV app or enable its inspector. It requires the endpoint's screenshot, preload, timezone, locale, and viewport emulation commands; unsupported TV inspector versions fail rather than pretending a screenshot was taken. This captures the overlay application's rendering surface, not the final HDMI/compositor picture. The TV can continue showing the last fixture until the app is dismissed.
