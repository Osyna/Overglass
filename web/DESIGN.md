# DESIGN: Lamplight

The committed visual world for the webOS Foundry web UI. `tokens.css` is generated from this file; `app.css` may only
reference those tokens. A redesign replaces this file.

## Brief (pinned, not asked)

"Make the web UI super good looking… make it super easy for a non-technical user to push a new app, use all the
functionality we bring."

- **Audience:** a non-technical person setting up or using their own smart TV, on a phone on the couch or a laptop.
- **Use case:** see the TV's state at a glance, then one tap: remote, message, card, install an app.
- **Tone (inferred from the brief, skipped brief gate):** soft and approachable, like a well-made smart-home app.
  Light first with a real dark mode. The previous build was a dark operate-mode console for power users; this one
  is the opposite on purpose.
- **Mode:** Operate. **Scope:** system (every panel).
- **Owner:** impeccable (existing web UI refined and rebuilt). Incumbent behaviour, ids and API calls kept.

## World

Warm paper, lit by a lamp. Surfaces are cream, text is warm brown-black, and the one signal colour is a tangerine.
Green means on or done, red means remove or failed. Nothing else carries colour except the five app-tile tints.

### Palette (OKLCH, in `tokens.css`)

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--bg` | 0.97 .012 80 | 0.20 .012 60 | page |
| `--surface` | 0.995 .004 80 | 0.25 .014 60 | cards, dialogs, inputs |
| `--sunken` | 0.94 .014 80 | 0.17 .012 60 | default button fill, wells, code |
| `--fg` / `--fg-2` / `--fg-3` | 0.25 / 0.42 / 0.50 | 0.95 / 0.82 / 0.72 | text; `--fg-3` is the quietest allowed (≥4.5:1) |
| `--accent` / `--accent-ink` | 0.55 .15 45 / 0.99 | 0.76 .14 55 / 0.20 | primary action, selected, focus ring |
| `--accent-tint` | 0.94 .04 55 | 0.32 .06 55 | selected rows, icon tiles |
| `--ok`, `--err`, `--warn-ink` + tints | green 160, red 25, amber 85 | lifted for dark | state only |
| `--line-strong` | 0.60 .022 70 | 0.58 .018 60 | control borders (≥3:1 on `--surface`) |
| `--tone-1…5` | five pastel tints | muted | letter tiles for apps with no usable icon |

Contrast was computed, not eyeballed: body text on `--bg` 14.7:1 light / 15.7:1 dark; `--fg-3` ≥5.0:1; accent ink on accent
5.0:1 light / 8.2:1 dark; status text on its tint ≥5.6:1.

No pure black or white. No gradients. Dark mode follows `prefers-color-scheme`; `theme.js` applies a saved manual
choice (`data-theme="light|dark"` on `<html>`, key `webos-foundry-theme`) before first paint.

### Type

`--font-ui: ui-rounded, "SF Pro Rounded", system-ui, …`; `--font-mono` for commands, ids and the request log only.

**Deliberate deviation from the "no system face as display" rule:** no font file is shipped. The page may only load
same-origin files and the TV has no CDN, so a face would have to be a licensed `.woff2` committed under `web/`; none was
available offline. Hierarchy therefore comes from size and weight only. To add one: put the `.woff2` in `web/`, add an
`@font-face` and point `--font-ui` at it in `tokens.css`. The server CSP already allows `font-src 'self'`.

Scale (ratio ≈1.25): `--text-xs` 13px · `--text-sm` 15px · `--text-base` 16px · `--text-lg` 20px · `--text-xl` 26px ·
`--text-2xl` fluid 28→40px. Weights 400 / 600 / 700. Display tracking −0.02em, headings balanced, body measure ≤65ch,
tabular numerals for every number that changes. Inputs are 16px so iOS never zooms.

### Space, shape, depth

`--space-1…7` = 4 · 8 · 12 · 16 · 24 · 32 · 48 px. Cards 16px radius, controls 14px, pills only for status chips and the
desktop tab bar. Elevation is a soft offset shadow on cards (never border plus shadow); inputs use a border because
they are not cards. Touch targets are ≥44px (`--tap`), checked at 360px.

### Motion

One authored moment: the ring that pulses around the TV orb while the app waits for a wake (transform and opacity only).
Everything else is state: 120ms colour changes, a 180ms view fade, a drawn check mark when an install succeeds.
No bounce, no `transition: all`, nothing animates layout. `prefers-reduced-motion` collapses all of it to ~0ms.

### Voice

Plain words for the action: "Turn on", "Add an app", "Show message", "Read aloud". Errors say what happened and what
to do next. Technical terms (IPK, SHA-256, token) appear once, with a one-line explanation beside them.

## Structure

Phone: sticky top bar (brand, TV status chip, theme, settings) and a fixed bottom bar with six sections. Desktop
(≥56rem): the same six as a centred pill tab bar in the header; content in a 72rem column, two columns per view.
Phone navigation labels are 12px to keep all six on one line at 320px. Compact desktop headers hide the brand text
and tighten tab padding so the navigation never collides with status or Settings.

| View | Holds |
| --- | --- |
| Home | first-run pairing help, TV status and power, shortcuts, TV details |
| Remote | power, input, direction pad, volume |
| Apps | add an app (file or link, with install progress), installed apps with uninstall |
| Automate | saved scenes with JSON creation/editing and run results; local-time schedules with day selection and enable/disable; private webhook links to copy or revoke; catalog-driven Extensions with settings, refresh intervals, install/update, enable/disable, preview and uninstall |
| Show | message and read-aloud, on-screen card with a collapsed Advanced builder (all twelve widget types, nested stacks/rows, live local preview, Send to TV), live view and screenshot (both open a full-screen zoom/pan lightbox) |
| Tune | picture & sound settings, process a file |
| Settings (gear) | appearance, who can use this page (token or login off), this device's token, link to developer tools |
| Developer (`#api`) | request log, API reference |

The Advanced card builder owns the draft tree. Its raw-JSON disclosure shows that exact root node; Apply JSON
validates and replaces the draft, while builder edits refresh the JSON. Unapplied JSON blocks sending and can be
discarded without changing the draft. The preview uses the TV renderer's widget proportions with Lamplight tokens,
not screenshot capture (the floating overlay is invisible to both TV capture paths). External images are labelled
placeholders to preserve the same-origin CSP; Send to TV uses the existing overlay route for final by-eye confirmation.
Comparison bars have 2–4 editable segments; small bar charts take 3–24 numbers separated by commas or spaces.
Images can be square or circular. Cards allow up to 5 nested levels and 60 widgets, within 32 KB of JSON.

Automate keeps Scenes in the left column and Scheduler / Webhook links stacked on the right, with Extensions below
both columns (all stacked on phones). Extension cards and their setting fields come from the server's catalog.
Install and Update enable the extension; enabling one disables any other. The server refreshes the enabled card,
not the page. Preview shows the current settings once without installing; uninstall confirms in place.
Scene editing uses the server’s existing `{"steps":[...]}` JSON format, not a second visual card builder. Scene-name
suggestions come from the saved list; names can also be entered before a scene exists. Deletes confirm in place;
deleting a scene does not remove its schedules or links. Webhook URLs are shown as read-only text and copied,
never opened or triggered by this page. Anyone with a link can run its scene, so the panel explains revocation.

Capability gating: `GET /api` is the single source of truth. A panel carrying `data-needs-group` or `data-needs-route`
that the server does not list is greyed, labelled "Not available from this server" and made inert. A remote button whose
action is missing from `/api/remote/{action}`'s `values` (wake, on the on-TV server) is hidden. Nothing is hard-coded to
a group name.

## Component rules

- **Buttons:** one `primary` per task area. Default is a sunken fill with no border. `danger` is outlined, `danger-fill`
  only inside a confirmation. Loading shows a spinner and keeps width.
- **Irreversible actions** confirm in place (uninstall: row turns into "Remove X from the TV? Keep it / Remove"; login
  off: dialog with consequences and an "I understand" checkbox that must be ticked before the button enables).
- **Install progress** shows only what is real: the upload fraction (file path), elapsed time, and the 90 s ceiling
  the TV side enforces. The TV's own part has no percentage because the route answers once, at the end.
- **Icons:** one inline SVG sprite in `index.html`, 24px grid, 2px round strokes, `currentColor`. No icon font, no emoji.
- **States:** every control has default, hover, `:focus-visible` (3px accent ring, instant), active, disabled, loading and,
  where it can fail, error. Status colour is never the only signal (text and icon accompany it).
- **Sign-in** is a dialog (`#token-dialog`): token field, "Remember on this device" (localStorage; otherwise
  sessionStorage), and a "Where do I find my token?" explainer.

## Files

`index.html` markup and icon sprite · `tokens.css` generated tokens · `app.css` components and layout · `theme.js` theme
switch (runs in `<head>`) · `app.js` API client, status, remote, notify, card, live, screenshot, zoom lightbox, pairing,
settings, scenes, scheduler, webhooks, extensions, jobs, API reference · `apps.js` apps, login setting, auth wiring, service-worker registration and the install banner ·
`favicon.svg` · `manifest.json`, `sw.js`, `icons/` installable app (the worker caches only the static shell, never `/api/`;
bump `CACHE` in `sw.js` to drop old copies) · `check-ui.mjs` offline markup/capability regression gate · `check-overlay.mjs`
widget-schema and builder checks · `check-automate.mjs` scene suggestions, schedule and extension toggles, catalog forms and copy-only webhook checks
(`node web/check-{ui,overlay,automate}.mjs`, no browser or TV).
