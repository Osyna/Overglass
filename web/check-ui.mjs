// Static regression gate for web/: every control the previous UI wired up must still exist in the new markup,
// every id the current JS looks up must exist, every local file reference must resolve, and the CSP rules must hold.
// Run: node web/check-ui.mjs   (no browser, no server, no network)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const html = read('index.html');
const js = ['theme.js', 'app.js', 'apps.js'].map(read).join('\n');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// Every id that the pre-redesign app.js looked up (getElementById / $() / id loops / chip- and hex- edges).
const BASELINE_IDS = [
  "api-intro", "api-routes", "chip-bottom", "chip-left", "chip-right", "chip-top",
  "details-body", "drop", "drop-main", "drop-sub", "file", "hex-bottom",
  "hex-left", "hex-right", "hex-top", "job", "job-cancel", "job-download",
  "job-elapsed", "job-form", "job-log", "job-msg", "job-preview", "job-release",
  "job-state", "job-title", "limits", "live-canvas", "live-fps", "live-msg",
  "live-size", "live-start", "live-stats", "live-stop", "live-view", "log-clear",
  "log-empty", "log-list", "log-polls", "mute", "notice", "notify-form",
  "notify-hint", "notify-msg", "notify-text", "notify-volume", "notify-volume-out", "ov-body",
  "ov-details", "ov-hide", "ov-kind", "ov-lines", "ov-position", "ov-seconds",
  "ov-show", "ov-title", "overlay-form", "overlay-hint", "overlay-msg", "pair-hint",
  "profile", "profile-field", "refresh-details", "refresh-settings", "refresh-status", "remote-hint",
  "settings-body", "shot-capture", "shot-download", "shot-msg", "shot-view", "shot-width",
  "speak", "st-power", "st-source", "st-temp", "st-volume", "start",
  "toast", "token-btn", "token-cancel", "token-clear", "token-dialog", "token-form",
  "token-input", "token-msg", "tv-addr", "view-api", "view-control", "volume-level"
];
// Replaced on purpose: the single Control view became one view per task.
const RENAMED = { 'view-control': ['view-home', 'view-remote', 'view-apps', 'view-automate', 'view-show', 'view-tune', 'view-settings'] };

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const idSet = new Set(ids);
for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) check(false, `duplicate id: ${id}`);

for (const id of BASELINE_IDS) {
  const want = RENAMED[id] || [id];
  for (const w of want) check(idSet.has(w), `baseline control missing from index.html: #${w}`);
}

const looked = new Set();
for (const m of js.matchAll(/\$\('([\w-]+)'\)|getElementById\('([\w-]+)'\)/g)) looked.add(m[1] || m[2]);
for (const m of js.matchAll(/for \(const id of \[([^\]]+)\]/g)) for (const i of m[1].matchAll(/'([\w-]+)'/g)) looked.add(i[1]);
for (const e of ['top', 'bottom', 'left', 'right']) { looked.add('chip-' + e); looked.add('hex-' + e); }
const renderedIds = new Set([...js.matchAll(/\bh\('[\w-]+',\s*\{[^}]*\bid:\s*'([\w-]+)'/g)].map(match => match[1]));
for (const id of looked) check(idSet.has(id) || renderedIds.has(id), `current JS looks up #${id}, with no static or rendered element`);

// Selectors the old code used, in their current form.
const has = (re, what) => check(re.test(html), `missing markup for ${what}`);
has(/class="status"/, '.status');
has(/class="power"/, '.status .power');
has(/class="seg"/, '.seg');
has(/class="tab"[^>]*data-view=|class="[^"]*\btab\b[^"]*"[^>]*data-view=/, '.tab[data-view]');
for (const [action, value] of [['wake'], ['power_off'], ['hdmi', '1'], ['hdmi', '2'], ['hdmi', '3'], ['hdmi', '4'], ['home'], ['up'], ['down'],
  ['left'], ['right'], ['ok'], ['back'], ['volume_up'], ['volume_down'], ['mute']]) {
  has(new RegExp(`data-action="${action}"` + (value ? `[^>]*data-value="${value}"` : '')), `data-action=${action}${value ? ' ' + value : ''}`);
}
for (const a of ['up', 'down', 'left', 'right', 'ok']) has(new RegExp(`class="key ${a}"[^>]*data-action="${a}"`), `.key[data-action=${a}] (keyboard remote)`);
check(/<section class="panel remote"/.test(html), '.remote panel (keyboard remote scope)');
for (const a of ['back', 'home']) has(new RegExp(`<div class="row center">[\\s\\S]*?data-action="${a}"`), `.remote .row [data-action=${a}]`);

// Views and navigation.
const viewIds = new Set([...html.matchAll(/data-view-id="([^"]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/data-view="([^"]+)"/g)) check(viewIds.has(m[1]), `nav tab points at missing view: ${m[1]}`);
for (const m of html.matchAll(/data-goto="([^"]+)"/g)) check(viewIds.has(m[1]), `data-goto points at missing view: ${m[1]}`);
const views = js.match(/const VIEWS = new Set\(\[([^\]]+)\]/)[1].match(/'([\w-]+)'/g).map((s) => s.slice(1, -1));
for (const v of views) check(viewIds.has(v), `VIEWS lists a view with no markup: ${v}`);
check([...html.matchAll(/class="tab" data-view="(home|remote|apps|automate|show|tune)"/g)].length === 6, 'six primary navigation sections');
for (const group of ['Scenes', 'Schedule', 'Webhooks', 'Addons']) has(new RegExp(`data-needs-group="${group}"`), `Automate capability gate for ${group}`);
for (const id of ['scene-form', 'scene-name', 'scene-json', 'scenes-list', 'scenes-msg',
  'schedule-form', 'schedule-time', 'schedule-list', 'schedule-msg', 'webhook-form', 'webhooks-list', 'webhooks-msg',
  'addons-list', 'addons-refresh', 'addons-msg']) {
  check(idSet.has(id), `Automate is missing #${id}`);
}
check([...html.matchAll(/name="day" value="(mon|tue|wed|thu|fri|sat|sun)"/g)].length === 7, 'seven schedule day choices');

// Studio's guided workflow keeps its advanced JSON editor reachable from every step.
const STUDIO_IDS = ['ov-templates', 'ov-paste', 'ov-paste-apply', 'ov-paste-msg', 'ov-ai', 'ov-ai-copy',
  'ov-schema-copy', 'ov-schema-download', 'ov-ai-msg', 'design-import', 'design-import-file', 'ov-layout',
  'ov-card-seconds', 'ov-look-form', 'ov-look-presets', 'ov-builder', 'ov-builder-msg', 'ov-json',
  'ov-json-apply', 'ov-json-reset', 'ov-json-msg', 'ov-meter', 'ov-meter-text', 'ov-preview', 'ov-preview-dock',
  'ov-send', 'design-form', 'design-name', 'design-save', 'design-export', 'design-copy', 'designs-list'];
for (const id of STUDIO_IDS) check(idSet.has(id), `Studio is missing #${id}`);
const tags = [...html.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi)];
const ancestors = new Map();
const openings = new Map();
const stack = [];
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
for (const match of tags) {
  const tag = match[1].toLowerCase();
  if (match[0].startsWith('</')) {
    const at = stack.findLastIndex(item => item.tag === tag);
    if (at !== -1) stack.length = at;
    continue;
  }
  const id = match[0].match(/\bid="([^"]+)"/)?.[1];
  const item = { tag, id, source: match[0] };
  if (id) { ancestors.set(id, [...stack]); openings.set(id, item); }
  if (!voidTags.has(tag) && !match[0].endsWith('/>')) stack.push(item);
}
for (const step of ['start', 'design', 'finish']) {
  const control = openings.get('ov-step-' + step);
  const panel = openings.get('ov-panel-' + step);
  check(control?.tag === 'button' && control.source.includes(`data-studio-step="${step}"`), `Studio ${step} needs its step button`);
  check(control?.source.includes(`aria-controls="ov-panel-${step}"`), `Studio ${step} button must name its panel`);
  check(panel?.source.includes(`data-studio-panel="${step}"`), `Studio ${step} needs its matching panel`);
}
for (const id of ['ov-json', 'ov-json-apply', 'ov-json-reset', 'ov-json-msg']) {
  check(!ancestors.get(id)?.some(item => /\bdata-studio-panel=/.test(item.source)), `#${id} must stay outside step panels`);
}
check(openings.get('ov-json')?.tag === 'textarea', 'the single Studio JSON editor must remain a textarea');
check(openings.get('ov-paste')?.tag === 'textarea', 'paste import needs a textarea');
check(openings.get('ov-ai')?.tag === 'details', 'AI help must be a collapsible details section');
check(openings.get('ov-preview-dock')?.tag === 'details' && /\bopen(?:\s|=|>)/.test(openings.get('ov-preview-dock').source),
  'Studio preview must be collapsible and open by default');
check(ancestors.get('ov-preview')?.some(item => item.id === 'ov-preview-dock'), 'preview belongs inside its mobile collapse dock');
for (const name of ['studio-grid', 'studio-controls', 'studio-preview']) has(new RegExp(`class="[^"]*\\b${name}\\b`), '.' + name);

// Capability gating: every gated panel needs a first-level .panel-head for the badge, and names a group or route.
for (const m of html.matchAll(/<section class="panel[^"]*"([^>]*data-needs-(?:group|route)=[^>]*)>([\s\S]*?)<\/section>/g)) {
  check(/^\s*<header class="panel-head"/.test(m[2]), `gated panel has no leading .panel-head: ${m[1].trim().slice(0, 60)}`);
}
const gated = [...html.matchAll(/data-needs-group="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
check(gated.includes('Processing'), 'the Processing panel must be gated by data-needs-group');
check(/function applyAvailability/.test(js) && !/group: 'Processing'/.test(js), 'availability must be generic, not hard-coded to one group');

// Icons: every <use> and icon() call has a symbol.
const symbols = new Set([...html.matchAll(/<symbol id="(i-[\w-]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/<use href="#(i-[\w-]+)"/g)) check(symbols.has(m[1]), `<use> without symbol: ${m[1]}`);
for (const m of js.matchAll(/\bicon\('([\w-]+)'\)/g)) check(symbols.has('i-' + m[1]), `icon() without symbol: ${m[1]}`);
for (const m of js.matchAll(/icon\([^)]*\? '([\w-]+)' : '([\w-]+)'/g)) for (const n of [m[1], m[2]]) check(symbols.has('i-' + n), `icon() without symbol: ${n}`);

// Local files: every root-relative reference in the markup exists in this directory.
for (const m of html.matchAll(/\s(?:href|src)="(\/[^"#?]*)"/g)) {
  const file = m[1] === '/' ? 'index.html' : m[1].slice(1);
  check(fs.existsSync(path.join(dir, file)), `reference to a file that is not in web/: ${m[1]}`);
}

// CSP (default-src 'none'; script/style 'self'): nothing inline, nothing off-origin.
check(!/\sstyle="/.test(html), 'inline style="" attribute');
check(!/<style[\s>]/.test(html), 'inline <style>');
check(!/<script(?![^>]*\ssrc=)/.test(html), 'inline <script>');
check(!/\son[a-z]+="/.test(html), 'inline event handler attribute');
check(!/https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org|example\.com)/.test(html + read('app.css') + read('tokens.css')), 'off-origin URL in markup or CSS');
check(!/@import|url\(/.test(read('app.css') + read('tokens.css')), 'CSS pulls in another resource (CSP allows only same-origin files, and there are none)');
check(!/\.setAttribute\('style'/.test(js), "setAttribute('style') is blocked by CSP");

// Tokens: no raw colours outside tokens.css.
check(!/#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\(|hsla?\(/.test(read('app.css').replace(/rgb\(\$\{/g, '')), 'app.css has a raw colour; lift it into tokens.css');

if (failures.length) {
  console.error(`check-ui: ${failures.length} problem(s)\n - ` + failures.join('\n - '));
  process.exit(1);
}
console.log(`check-ui: ok (${BASELINE_IDS.length} baseline controls, ${looked.size} looked-up ids, ${symbols.size} icons, ${viewIds.size} views)`);
