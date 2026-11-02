# Stillwater

The design system for the webOS Foundry browser app. This replaces Lamplight. The audience is a TV owner, not a developer: someone opening the app on the sofa with a phone, or managing their TV from a laptop.

The product should feel calm, modern and dependable. It shows the next useful action without hiding the existing TV controls. Its mode is **Operate**, its scope is the whole interface, and its Signet owner is **impeccable**.

## Constraints

- Vanilla HTML, JavaScript and CSS, with no build step or external resources.
- Strict CSP: scripts and styles are separate files; no inline event handlers or authored style attributes.
- Existing control IDs, capability attributes and API behavior remain the integration contract.
- All authored colors live in `tokens.css`. `app.css` uses tokens, `currentColor` and inherited color. User-selected card themes and sampled live-screen colors are runtime data, not app palette choices.
- No font download. The local Avenir/Segoe UI/Noto Sans stack is a deliberate offline choice, including headings. Monospace is reserved for code and identifiers.
- The TV preview has its own dark palette and font stack. Changing the browser app's appearance must not recolor a card.

## Visual system

### Color

Neutral surfaces carry a slight green cast. Evergreen is the single product accent: the main action, selected navigation, selected widgets and keyboard focus. Success uses the same green family. Red and amber are reserved for errors, destructive actions and warnings; they are not decorative accents. App letter tiles use quiet variations within the neutral-green family.

| Role | Tokens |
| --- | --- |
| Page, panel, recessed control | `--bg`, `--surface`, `--sunken`, `--sunken-hover` |
| Separators, input boundaries | `--line`, `--line-strong` |
| Primary, secondary, supporting text | `--fg`, `--fg-2`, `--fg-3` |
| Main action and selection | `--accent`, `--accent-hover`, `--accent-ink`, `--accent-tint` |
| Success, error, warning | `--ok*`, `--err*`, `--warn-*` |
| Temporary notice and modal veil | `--inverse*`, `--scrim` |
| TV renderer colors | `--tv-*` |

Light mode is the default. Dark mode follows `prefers-color-scheme` unless `theme.js` applies a saved `data-theme="light|dark"` choice before paint. Both themes use the same hierarchy and accent role. No gradients, blur effects or decorative illustration are required.

### Type and spacing

Body and input text is 16px. Supporting copy is 15px, hints 13px, section headings 20px, and page headings scale from 30px to 42px. The phone tab labels are smaller to fit six destinations without wrapping. Headings use weight and modest negative tracking rather than a separate display font. Changing values use tabular numerals.

The spacing scale is 4, 8, 12, 16, 24, 32 and 48px. Related inputs sit close together; different tasks have a larger gap or a fine divider. Content is bounded at 1360px including gutters. Text explanations stay around 65 characters wide where practical.

Panels use one quiet border and a 16px corner radius. Controls use 8px corners. Status chips alone use pill shapes. Shadows are reserved for transient surfaces such as dialogs and notices, plus the phone navigation's separation from content. The TV stage retains the actual TV renderer's borders and shadows, independently of these app rules.

### Interaction and accessibility

- Touch targets are at least 44px, including widget tools and icon buttons. Direction controls are larger.
- Keyboard focus is an immediate 3px accent outline with a 3px offset.
- Selected states use a boundary or fill as well as text color. Status keeps its visible label; color alone is not the explanation.
- Disabled controls stay visible but subdued. Loading uses the existing busy state and spinner without replacing the action label.
- Field errors use `aria-invalid` and the nearby status text. Result messages support success and error tones; unavailable capabilities remain labeled by the application.
- Native details/summary provides disclosure behavior; native dialogs are retained for sign-in, security consequences and image inspection.
- Reduced-motion preferences collapse animation and transition durations. Motion otherwise serves state: loading spinners, the existing waking indicator and an install-completion check. Panels do not animate into view.
- Long names, identifiers, explanations and filenames can wrap. Code areas and reference tables scroll locally rather than widening the page.

## Voice

Use direct actions: **Turn on**, **Choose an app file**, **Use pasted card**, **Send to TV**, **Save design**. Use “card” for what appears on the TV, “design” for a saved card, and “scene” for a sequence of actions.

Explain a technical term where it first matters. JSON and schema tools belong in labeled disclosures, not in the primary workflow. Errors should say what failed and how to recover. Do not imply that previewing sends to the TV, that sending saves a design, or that importing changes saved designs.

The AI helper is copy-and-paste guidance for the owner's chosen chat app. This browser app does not call an AI service. Privacy explanations for screen capture and private webhook links stay beside the relevant controls.

## Navigation and responsive layout

The six main destinations remain Home, Remote, Apps, Automate, Show and Tune. Appearance and access controls are under Settings; developer tools are linked from Settings.

- **Above 1099px:** brand, top navigation and TV status/settings occupy one sticky header row.
- **641–1099px:** navigation occupies its own second header row so controls do not collide.
- **640px and below:** navigation becomes a fixed bottom tab bar. The top header keeps the brand mark, TV status, appearance toggle and Settings. Safe-area padding protects both bars and the page content.
- **800px and below:** ordinary two-column task layouts become one column.
- **1000px and below:** the Studio preview moves above its editor as a collapsible dock, open initially. On wider screens it stays to the right and sticks below the header.
- **640px and below:** the widget outline and inspector stack, and saved designs use a single thumbnail column.

These are layout rules, not claims of completed browser or hardware verification.

## Per-view layouts

### Home

TV status and power are the anchor on the left, followed by plain shortcut rows. TV details occupy the other column. Status separates power, input, volume and temperature into readable facts. First-run pairing replaces the normal home columns until a TV is paired; its key-file and paste options retain the existing behavior.

### Remote

The directional pad is the primary tactile control. On larger screens it sits to the left of power, input and volume; phones stack these groups in familiar reading order. The selected HDMI input and mute state remain visible. Keyboard hints appear on larger pointer-capable devices, without taking space from phone controls.

### Apps

Installation and installed apps are separate columns on larger screens. The file drop target is the first installation path; a link is the alternative. The upload and install phases show only real progress and elapsed time. Installed apps remain icon-and-name rows with in-place remove confirmations and visible errors.

### Automate

Scenes occupy one column; schedules and private webhook links share the other. Extensions span the content below. The guided scene builder uses ordered steps, labeled action fields and the shared move/duplicate/remove tool row. Raw scene JSON remains a disclosed advanced route, not a second card designer.

Schedule day controls wrap naturally. Webhook links remain read-only, copyable text rather than navigable actions. Extension cards and setting fields are catalog-driven, including position, size and compact appearance controls. Their status, install/update, preview, enable/disable and remove actions retain the API's semantics.

### Show: Card studio

Studio comes first. It owns one draft throughout three steps:

1. **Start:** seven template tiles with miniature TV previews, paste/import, and a disclosed AI helper with copyable instructions and schema tools.
2. **Design:** layout and display time, named Look presets with optional detailed controls, then the widget editor.
3. **Finish:** send or hide the card, save a named design, download the card file or copy its JSON.

Step buttons keep the draft intact. Card capacity and the raw-JSON disclosure sit outside the step panels, so changing steps never hides access to the draft's code. JSON is applied explicitly or when its textarea loses focus. The browser checks the card and asks `POST /api/overlay/validate` for the server's verdict; an accepted, previewable response becomes the draft, with widget and byte counts from the server. Unapplied JSON or validation in progress makes the Design panel inert and visually subdued, and disables sending, saving, copying and export. Failed validation leaves the previous draft intact rather than silently replacing it.

Each region has a nine-position mini-TV picker: four corners, center, top and bottom bars, and left and right panels. The widget workspace separates a nested outline from an inspector for the chosen widget. The outline exposes selection and structural actions; the inspector exposes fields. A grouped palette below offers SVG, name and a plain-language description for each widget type. It does not require the owner to know schema type names.

Look presets are shortcuts into the same card theme, not a second theme system. Unset properties retain TV defaults. Layout remains one card or up to four regions; the existing limits remain 80 widgets, five nesting levels and 49152 bytes of JSON.

### TV preview

A 16:9 `.tv-stage` contains a scaled 1920×1080 `.tv-screen`. The preview uses the TV overlay's geometry, fonts where available, palette, widget sizes, edge margins and panel widths, not the app's control styles. Images from other origins are labeled placeholders to respect CSP. Text can differ where the browser lacks the TV's installed fonts.

**The edge-presence contract is `data-edges` on `.tv-screen`.** Its space-separated values are `top bottom left right`, limited to present edge regions. JavaScript measures top/bottom bars and fits side-panel insets. CSS mirrors `tv-assets/overlay/overlay.css`: adjoining side-panel borders disappear, shared corners become square, and joined edge-bar shadows disappear. This makes multi-region HUDs read as one continuous surface rather than overlapping cards.

All existing widget families remain styled: stack, row, text, image placeholder, badge, dot, progress, countdown, clock, list, divider, compare, sparkline, section, event, stat, status and meta. Their tones remain TV-specific. Comparison, statistic and sparkline tracks use separate TV tokens where the renderer does.

The preview is a guide, not a screenshot of the overlay. The actual floating card is absent from the existing HDMI capture paths.

### My designs and secondary screen tools

Saved designs appear as a thumbnail grid with a name and action row. They can be loaded, shown, renamed, removed or exported using the existing application flow. Destructive and replacement choices confirm in place. Inline rename fields remain inside the relevant tile rather than interrupting the page with another dialog.

Quick messages, simple text cards, live view and screenshots remain below My designs as native disclosures. They preserve their original forms, IDs and controls without crowding Studio. Captures keep zoom/pan inspection and the privacy explanation; the captured HDMI input does not include floating cards.

### Tune

Picture and sound settings share the page with file processing. Settings are grouped, with scope and availability beside each control. Processing retains the drop target, profile choice, status, cancellation, downloadable result, preview and processor log. Neither browser styling nor the studio Look controls change the TV's picture settings.

### Settings and developer tools

Appearance choices, access mode, the saved token and the developer entry point form a readable narrow stack. Login-off consequences and the explicit acknowledgment remain in their security dialog. The API reference and request log keep monospace methods/paths, local scrolling and copy-ready commands, using the same restrained surfaces as the rest of the app.

## File responsibilities and maintenance

`tokens.css` defines palette, type stacks, scale, spacing, shape, motion and TV constants. `app.css` defines layout and component states. `index.html` owns semantic structure and the icon sprite; `app.js` and `apps.js` own state and API behavior. `theme.js` sets appearance before paint. `sw.js` owns shell caching and must change its cache version with a shell redesign.

For UI changes, run the offline UI, overlay and automation gates together after markup, styling and behavior changes have landed. Browser inspection should cover phone, tablet and desktop layouts in both themes, keyboard use and contrast. Preview fidelity also needs comparison with the actual TV; an offline gate cannot establish font or hardware rendering equivalence.
