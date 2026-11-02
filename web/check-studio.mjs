// Run: node web/check-studio.mjs. Offline behavioral checks; no TV or dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.checked = false;
    this.style = { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } };
    this.classList = { add: name => { this.className = ((this.className || '') + ' ' + name).trim(); }, contains: name => (this.className || '').split(' ').includes(name), toggle: (name, on) => { if (on) this.classList.add(name); } };
  }
  setAttribute(key, value) { this[key === 'class' ? 'className' : key] = ['checked', 'disabled', 'selected', 'open', 'hidden', 'required'].includes(key) ? true : value; }
  getAttribute(key) { return this[key === 'class' ? 'className' : key] ?? null; }
  removeAttribute(key) { delete this[key]; }
  append(...children) { for (const child of children) { assert(!Array.isArray(child)); this.children.push(child); if (child instanceof Element) child.parent = this; } if (this.tag === 'select') this.value = (this.children.find(child => child.selected) || this.children[0])?.value; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  removeEventListener(name) { delete this.listeners[name]; }
  matches(selector) { return selector.split(',').some(raw => { const part = raw.trim(); if (part === 'input:checked') return this.tag === 'input' && this.checked; return part.startsWith('.') ? this.classList.contains(part.slice(1)) : part.startsWith('#') ? this.id === part.slice(1) : this.tag === part; }); }
  querySelectorAll(selector) { return this.children.filter(child => child instanceof Element).flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() { this.focused = true; }
  setPointerCapture(id) { this.pointerId = id; }
  hasPointerCapture(id) { return this.pointerId === id; }
  releasePointerCapture() { delete this.pointerId; }
  getBoundingClientRect() { return { width: 960 }; }
  get firstElementChild() { return this.children.find(child => child instanceof Element); }
}
const elements = new Map(), storage = new Map(), timers = new Map(), revoked = [];
let nextTimer = 0, nextBlob = 0;
class TestURL extends URL {
  static createObjectURL() { return 'blob:test-' + (++nextBlob); }
  static revokeObjectURL(value) { revoked.push(value); }
}
const context = vm.createContext({
  assert, TextEncoder, TextDecoder, AbortController, Blob, URL: TestURL, revoked, timers,
  setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timers.delete(id); }, setInterval() {},
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  document: {
    hidden: false, body: new Element('body'), addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    createElement: tag => new Element(tag), createElementNS: (namespace, tag) => new Element(tag),
    getElementById(id) { if (!elements.has(id)) { const element = new Element('div'); element.id = id; elements.set(id, element); } return elements.get(id); },
  },
  location: { origin: 'http://localhost:8765', hash: '#show', pathname: '/' },
});
for (const name of ['qrcode.js', 'studio.js', 'app.js']) vm.runInContext(fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8'), context);
await vm.runInContext(`(async () => {
  const button = (host, text) => host.querySelectorAll('button').find(element => element.textContent === text);
  const field = (host, name) => host.querySelectorAll('input').find(element => element['aria-label'] === name);
  syncNotify = () => {}; say = () => {}; S.view = 'show';
  const realUpdate = updateOverlayDraft;

  // Schema parity covers every new node, optional offsets, timeline caps and safe SVG grammar.
  for (const type of ['grid', 'ticker', 'qr', 'svg']) checkOverlayCard({ root: newOverlayNode(type) });
  checkOverlayCard({ root: newOverlayNode('text'), offset: { x: 12 }, animation: { enter: 'slide', exit: 'wipe', duration_ms: 2000 }, behavior: { on_foreground: 'shrink', ambient_dim: true } });
  checkOverlayCard({ timeline: [{ seconds: 1, card: { root: newOverlayNode('qr') } }, { seconds: 300, card: { root: newOverlayNode('svg') } }] });
  for (const bad of [{ root: newOverlayNode('grid'), offset: { x: 1921 } }, { root: { type: 'grid', columns: 1.5, children: [{ type: 'dot' }] } }, { root: { type: 'ticker', text: '', speed: 1 } }, { root: { type: 'qr', text: '😀'.repeat(1000) } }, { timeline: [{ seconds: 0, card: { root: { type: 'dot' } } }] }, { root: { type: 'dot' }, timeline: [{ seconds: 1, card: { root: { type: 'dot' } } }] }]) assert.throws(() => checkOverlayCard(bad));
  for (const action of ['state', 'runtime']) assert.throws(() => checkOverlayCard({ action, root: { type: 'dot' } }), 'transport-only actions cannot enter the draft or design store');
  for (const source of ['<svg><script/></svg>', '<svg onload="x"><path d="M0 0"/></svg>', '<svg><image href="https://example.com"/></svg>', '<svg><text>secret</text></svg>', '<svg><path fill="url(x)"/></svg>', '<svg><path></svg>', '<svg/><svg/>', '<svg><!-- comment --></svg>']) assert.throws(() => checkStudioSvg(source));
  assert.ok(previewOverlayNode(newOverlayNode('qr')).querySelector('svg'));
  assert.ok(previewOverlayNode(newOverlayNode('svg')).querySelector('circle'));

  // Bounded undo/redo retains all content and branches cleanly after undo.
  updateOverlayDraft = () => { studioRecordDraft(); };
  overlayCard = { root: { type: 'text', text: '0' } }; studioHistory = []; studioHistoryIndex = -1;
  for (let i = 0; i < 70; i++) { overlayCard.root.text = String(i); studioRecordDraft(); }
  assert.equal(studioHistory.length, STUDIO_HISTORY_LIMIT); studioUndo(-1); assert.equal(overlayCard.root.text, '68'); studioUndo(1); assert.equal(overlayCard.root.text, '69');
  studioUndo(-1); overlayCard.root.text = 'branch'; studioRecordDraft(); studioUndo(1); assert.equal(overlayCard.root.text, 'branch');
  overlayJsonDirty = true; studioUndo(-1); assert.equal(overlayCard.root.text, 'branch'); overlayJsonDirty = false;

  // Structural changes move bindings with their actual widget, never the old index.
  overlayCard = { root: { type: 'stack', children: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'grid', columns: 1, children: [{ type: 'dot' }] }] }, bindings: [{ target: '/root/children/0/text', source: { kind: 'json', url: 'https://example.com/data', path: 'value' } }] };
  overlaySelected = overlayCard.root.children[0]; studioRecordDraft();
  assert.equal(studioMoveWidget(overlayCard.root.children[1], overlayCard.root.children[0]), true);
  assert.equal(overlayCard.bindings[0].target, '/root/children/1/text');
  assert.equal(studioMoveWidget(overlayCard.root, overlayCard.root.children[0]), false, 'a root cannot be moved into itself');
  const group = overlayCard.root.children[2]; assert.equal(studioMoveWidget(overlayCard.root.children[1], group, true), true);
  assert.equal(overlayCard.bindings[0].target, '/root/children/1/children/1/text');
  const validBound = clone(overlayCard);
  for (const target of ['/root/type', '/root/children/0/src', '/__proto__/text']) assert.throws(() => checkOverlayCard({ ...clone(validBound), bindings: [{ target, source: { kind: 'json', url: 'https://example.com', path: 'value' } }] }));
  for (const url of ['file:///etc/passwd', 'https://user:secret@example.com/data']) assert.throws(() => checkOverlayCard({ ...clone(validBound), bindings: [{ ...validBound.bindings[0], source: { kind: 'json', url, path: '' } }] }));
  assert.throws(() => checkOverlayCard({ ...clone(validBound), bindings: [{ ...validBound.bindings[0], source: { kind: 'json', url: 'https://example.com', path: '__proto__.value' } }] }));

  overlayCard = { root: { type: 'list', items: ['One', 'Two'] }, bindings: [{ target: '/root/items/1', source: { kind: 'json', url: 'https://example.com/data', path: 'value' } }] };
  studioCaptureBindingAnchors(); overlayCard.root.items = ['Changed', 'Second']; studioRecordDraft();
  assert.equal(overlayCard.bindings[0].target, '/root/items/1', 'editing scalar arrays retains binding positions');
  const progressBinding = { root: { type: 'progress', value: 0.5 }, bindings: [{ target: '/root/value', source: { kind: 'json', url: 'https://example.com', path: '' }, fallback: '0.25' }] };
  checkOverlayCard(progressBinding); progressBinding.bindings[0].fallback = 'not a number'; assert.throws(() => checkOverlayCard(progressBinding));
  progressBinding.bindings[0].fallback = null; assert.throws(() => checkOverlayCard(progressBinding), 'null is not a display scalar');
  progressBinding.bindings[0].fallback = 0.5; progressBinding.bindings[0].source.kind = 'homeassistant'; assert.throws(() => checkOverlayCard(progressBinding), 'HA needs an explicit token');
  progressBinding.bindings[0].source.required_secrets = ['token']; checkOverlayCard(progressBinding);

  // Keyboard editing never intercepts a text field, and paste obeys the same tree constraints.
  overlayCard = { root: { type: 'stack', children: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }; overlaySelected = overlayCard.root.children[0];
  const key = (name, target = document.createElement('button'), ctrl = false) => { let prevented = false; studioKeyboard({ key: name, target, ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: false, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(key('Delete', document.createElement('input')), false); assert.equal(overlayCard.root.children.length, 2);
  assert.equal(key('c', undefined, true), true); assert.equal(key('v', undefined, true), true); assert.equal(overlayCard.root.children.length, 3);
  assert.equal(key('ArrowDown'), true); assert.equal(key('Delete'), true); assert.equal(overlayCard.root.children.length, 2);

  // Preview drag coordinates are in TV pixels, bounded, persisted once on pointer-up.
  updateOverlayDraft = () => {};
  const region = { position: 'top-right', root: { type: 'dot' } }, article = document.createElement('article'), stage = $('ov-preview');
  studioPositionRegion(article, region, stage);
  article.listeners.pointerdown({ button: 0, clientX: 100, clientY: 100, pointerId: 1, preventDefault() {} });
  article.listeners.pointermove({ clientX: 150, clientY: 75 });
  assert.equal(JSON.stringify(region.offset), JSON.stringify({ x: 100, y: -50 }));
  article.listeners.pointerup({ pointerId: 1 }); assert.equal(article.style['--offset-x'], '100px');
  const docked = document.createElement('article'); studioPositionRegion(docked, { ...region, position: 'top' }, stage); assert.equal(docked.listeners.pointerdown, undefined);
  overlayCard = { position: 'center', theme: { scale: 1.5 }, root: { type: 'dot' } }; renderTvStage(stage, overlayBody());
  const liveArticle = stage.querySelector('.tv-card'); liveArticle.listeners.pointerdown({ button: 0, clientX: 0, clientY: 0, pointerId: 2, preventDefault() {} });
  liveArticle.listeners.pointermove({ clientX: 75, clientY: 0 }); liveArticle.listeners.pointerup({ pointerId: 2 });
  assert.equal(overlayCard.offset.x, 100, 'a scaled preview edits the real draft, not its render clone');

  // Sharing is portable, geometry-only and credential-free; captures never enter bundles.
  const card = { root: { type: 'text', text: 'Public label' }, bindings: [{ target: '/root/text', source: { kind: 'json', url: 'https://example.com/data?token=hidden', path: 'value', token: 'private-bearer' } }] };
  const bundle = studioBundle(card, 'A design');
  assert.doesNotMatch(JSON.stringify(bundle), /private-bearer|token=hidden|blob:test/);
  const publicUrl = 'https://example.com/data?latitude=51.5&longitude=-0.1';
  assert.equal(studioRedact({ url: publicUrl }).url, publicUrl, 'redaction preserves non-secret query values');
  assert.equal(studioRedact({ url: 'https://example.com/data?token=hidden&view=table' }).url, 'https://example.com/data?view=table');
  assert.ok(bundle.required_secrets.includes('/bindings/0/source/token')); assert.ok(bundle.required_secrets.includes('/bindings/0/source/url'));
  checkStudioSvg(bundle.thumbnail); checkOverlayCard(bundle.card);
  const numeric = studioScalarControl(1); assert.equal(numeric.read(), 1); const numericInput = field(numeric.element, 'Scalar value'); numericInput.value = 'Infinity'; assert.throws(numeric.read);
  const boolean = studioMetadataInput({ key: 'allow_private', type: 'boolean', default: false }); assert.equal(boolean.checked, false);
  const secret = studioMetadataInput({ key: 'token', type: 'secret' }, 'saved'); assert.equal(secret.type, 'password');
  const number = studioMetadataInput({ key: 'latitude', type: 'number', min: -90, max: 90, step: 0.1 }, 0); assert.equal(number.value, 0); assert.equal(number.min, -90);

  // Live sends are serialized and coalesce edits; stale resolution never sends old content.
  const requests = []; let release;
  call = async (method, path, options) => { requests.push({ method, path, card: options?.json }); if (path === '/api/overlay') await new Promise(resolve => { release = resolve; }); return { message: 'sent' }; };
  overlayCard = { root: { type: 'text', text: 'first' } }; overlayError = ''; overlayValidationBusy = false; S.overlayBusy = false; $('ov-live-edit').checked = true; studioLiveSent = ''; studioLivePending = true;
  const first = studioFlushLive(); await Promise.resolve();
  overlayCard.root.text = 'second'; studioQueueLive(); await studioFlushLive(); assert.equal(requests.length, 1, 'no overlapping overlay request');
  overlayCard.root.text = 'latest'; release(); await first; const second = studioFlushLive(); await Promise.resolve(); assert.equal(requests.length, 2); assert.equal(requests[1].card.root.text, 'latest'); release(); await second;
  let resolveData;
  requests.length = 0; S.overlayBusy = false; overlayCard = clone(card); $('ov-live-edit').checked = true; studioLivePending = true;
  call = async (method, path, options) => { requests.push({ method, path }); if (path.endsWith('/resolve')) return await new Promise(resolve => { resolveData = resolve; }); return { message: 'sent' }; };
  const resolving = studioFlushLive(); await Promise.resolve(); overlayCard.root.text = 'changed during resolution'; resolveData({ card: { root: { type: 'text', text: 'stale resolved value' } } }); await resolving;
  assert.equal(requests.filter(request => request.path === '/api/overlay').length, 0, 'a stale resolved snapshot is discarded');
  studioCancelLive(true); assert.equal($('ov-live-edit').checked, false);

  // A snapshot is opt-in, private, short-lived and revoked on clearing.
  S.view = 'show'; call = async (method, path, options) => { assert.equal(options.private, true); return new Blob(['image'], { type: 'image/jpeg' }); };
  await studioCaptureSnapshot(); assert.match(stage.style['--tv-snapshot'], /blob:test-/); assert.ok([...timers.values()].some(timer => timer.delay === 300000));
  const old = studioSnapshot; studioClearSnapshot(); assert.ok(revoked.includes(old)); assert.equal(stage.style['--tv-snapshot'], undefined);
  let finishCapture; call = () => new Promise(resolve => { finishCapture = resolve; }); const pendingCapture = studioCaptureSnapshot(); studioClearSnapshot(); finishCapture(new Blob(['late'], { type: 'image/jpeg' })); await pendingCapture; assert.equal(studioSnapshot, null, 'clearing also invalidates an in-flight capture');

  // Timeline controls keep the real card and avoid inheriting an eight-second global cap.
  updateOverlayDraft = () => {}; overlayCard = { seconds: 8, theme: { accent: '#84b5ec' }, root: { type: 'text', text: 'First step' } }; studioFrame = 0;
  renderStudioExtras(); button($('ov-timeline'), 'Make a timeline').listeners.click(); assert.equal(overlayCard.seconds, undefined); assert.equal(overlayCard.timeline[0].card.root.text, 'First step');
  renderStudioExtras(); button($('ov-timeline'), 'Add timeline step').listeners.click(); assert.equal(overlayCard.timeline.length, 2); assert.equal(studioFrame, 1);
  studioApplyLook({ accent: '#efc47d' }); assert.equal(overlayCard.timeline[1].card.theme.accent, '#efc47d');
  renderStudioExtras(); button($('ov-timeline'), 'Use this look for every step').listeners.click();
  assert.equal(overlayCard.theme.accent, '#efc47d'); assert.equal(overlayCard.timeline[1].card.theme, undefined);
  checkOverlayCard(overlayCard);

  // Import previews are inert until confirmed; restore sends the selected revision ID.
  const libraryCalls = [], sample = { root: { type: 'text', text: 'Imported' } };
  loadAutomation = async () => {};
  call = async (method, path, options) => {
    libraryCalls.push({ method, path, json: options?.json });
    if (path === '/api/designs') return { designs: { Existing: sample } };
    if (path.endsWith('/history')) return { versions: [{ id: 'revision-1', created_at: '2026-01-01T00:00:00Z', card: sample }] };
    return { card: sample, message: 'Saved' };
  };
  await studioImport({ name: 'design.json', size: 400, text: async () => JSON.stringify(studioBundle(sample, 'Existing')) });
  assert.equal(libraryCalls.length, 0, 'preview does not save, resolve or show');
  await button($('ov-import-preview'), 'Import to My designs').listeners.click();
  assert.equal(libraryCalls.length, 1); assert.equal(libraryCalls[0].method, 'GET');
  $('ov-import-preview').querySelector('input').value = 'Changed after review';
  await button($('ov-import-preview'), 'Overwrite').listeners.click();
  const imported = libraryCalls.find(request => request.path === '/api/designs/import');
  assert.equal(imported.json.overwrite, true); assert.equal(imported.json.name, 'Existing');
  const row = document.createElement('li'); await studioVersions('Existing', row);
  button(row, 'Restore saved version').listeners.click();
  await button(row, 'Restore').listeners.click();
  const restored = libraryCalls.find(request => request.path.endsWith('/restore')); assert.equal(restored.json.id, 'revision-1');

  overlayCard = { theme: { accent: '#84b5ec' }, root: { type: 'text', text: 'Saved widget' } };
  $('ov-theme-name').value = 'Evening'; let themeRequest;
  call = async (method, path, options) => { if (method === 'PUT') themeRequest = { path, json: options.json }; return { themes: { Evening: overlayCard.theme } }; };
  await studioSaveTheme(); assert.equal(themeRequest.path, '/api/themes/Evening'); assert.equal(themeRequest.json.accent, '#84b5ec');
  renderOverlayBuilder = () => {};
  const preset = studioPresetControls(overlayCard.root); field(preset, 'Widget preset name').value = '__proto__'; button(preset, 'Save widget preset').listeners.click();
  const storedPresets = studioReadPresets(); assert.equal(Object.hasOwn(storedPresets, '__proto__'), true); assert.equal(storedPresets.__proto__.text, 'Saved widget');

  // Exact volume commits only on release; the high-volume opt-in never changes the TV itself.
  const originalLoadStatus = loadStatus, originalQueryAll = document.querySelectorAll;
  const volumeButtons = ['volume_up', 'volume_down', 'mute'].map(action => {
    const node = document.createElement('button'); node.dataset.action = action; return node;
  });
  document.querySelectorAll = selector => selector.startsWith('[data-action') ? volumeButtons : originalQueryAll(selector);
  const slider = $('remote-volume-slider'), unlock = $('volume-unlock'), volumeCalls = [];
  let actualVolume = 24, volumeFailure = false, volumeRelease = null;
  S.api = { routes: [{ path: '/api/remote/{action}', values: [{ name: 'volume' }] }] };
  S.status = { power: 'on', volume: actualVolume }; S.statusError = null; S.paired = true; S.reserved = false;
  loadStatus = async () => { S.status.volume = actualVolume; };
  call = async (method, path, options) => {
    volumeCalls.push({ method, path, value: options.json.value });
    if (volumeFailure) throw new Error('Readback mismatch');
    if (volumeRelease) await new Promise(resolve => { volumeRelease = resolve; });
    actualVolume = options.json.value; return { message: 'Volume ' + actualVolume };
  };
  unlock.checked = true; wireRemoteVolume(); syncRemoteVolume(); assert.equal(unlock.checked, false); assert.equal(slider.max, '40'); assert.equal(slider.value, '24');
  slider.value = '55'; await setRemoteVolume(); assert.equal(volumeCalls.length, 0, 'locked requests cannot exceed 40');
  slider.value = '55'; slider.listeners.input(); assert.equal(slider.value, '40'); assert.equal(volumeCalls.length, 0, 'dragging is local');
  S.status.volume = 22; syncRemoteVolume(); assert.equal(slider.value, '40', 'status pushes do not interrupt a drag');
  await slider.listeners.change(); assert.equal(volumeCalls[0].path, '/api/remote/volume'); assert.equal(volumeCalls[0].value, 40); assert.equal(volumeButtons[0].disabled, true);
  slider.value = '0'; slider.listeners.input(); volumeRelease = true;
  document.activeElement = slider;
  const sendingVolume = slider.listeners.change(); await Promise.resolve();
  assert.equal(slider.disabled, true); assert.equal(unlock.disabled, true); assert.ok(volumeButtons.every(button => button.disabled));
  document.activeElement = document.body;
  await setRemoteVolume(); assert.equal(volumeCalls.length, 2, 'no overlapping volume writes');
  volumeRelease(); await sendingVolume; volumeRelease = null;
  assert.equal(actualVolume, 0); assert.equal(slider.value, '0'); assert.equal(volumeButtons[1].disabled, true);
  assert.equal(slider.focused, true, 'keyboard users retain the slider after a confirmed write'); delete document.activeElement;
  unlock.checked = true; unlock.listeners.change(); assert.equal(volumeCalls.length, 2); assert.equal(slider.max, '100');
  slider.value = '100'; slider.listeners.input(); await slider.listeners.change(); assert.equal(actualVolume, 100);
  unlock.checked = false; unlock.listeners.change();
  assert.equal(actualVolume, 100, 'relocking must not turn the TV down'); assert.equal(volumeCalls.length, 3); assert.equal(slider.value, '40'); assert.match($('volume-limit-hint').textContent, /100/);
  assert.equal(volumeButtons[0].disabled, true); assert.equal(volumeButtons[1].disabled, false);
  for (const bad of ['-1', '40.5', '101', 'NaN']) { slider.value = bad; await setRemoteVolume(); }
  assert.equal(volumeCalls.length, 3);
  actualVolume = S.status.volume = 18; syncRemoteVolume(); volumeFailure = true; slider.value = '20'; slider.listeners.input(); await slider.listeners.change();
  assert.equal(slider.value, '18', 'failed writes return to the actual TV state'); assert.match($('volume-send-msg').textContent, /not confirmed.*Readback mismatch/); assert.equal(S.volumeBusy, false);
  studioRole = 'guest'; studioActions = ['volume_up']; syncRemoteVolume(); assert.equal(slider.disabled, true);
  studioActions = ['volume']; syncRemoteVolume(); assert.equal(slider.disabled, false);
  studioRole = ''; studioActions = [];
  S.reserved = true; syncRemoteVolume(); assert.equal(slider.disabled, true); S.reserved = false;
  S.status.power = 'off'; syncRemoteVolume(); assert.equal(slider.disabled, true); S.status.power = 'on';
  S.status.volume = null; syncRemoteVolume(); assert.equal(slider.disabled, true); S.status.volume = 18;
  S.api.routes[0].values = [{ name: 'volume_up' }]; syncRemoteVolume(); assert.equal(slider.disabled, true);
  loadStatus = originalLoadStatus; document.querySelectorAll = originalQueryAll; S.api = null;

  // Authenticated SSE handles split CRLF frames, carries no query token and aborts cleanly.
  let drain, eventFetch, cancelled = 0, reads = 0;
  const encoder = new TextEncoder();
  const parts = ['event: state\\r\\ndata: {\"status\":{\"power\":\"on\"},\"overlay\":{\"visible\":true}}\\r', '\\n\\r\\n'];
  const reader = { async read() { if (reads < parts.length) return { done: false, value: encoder.encode(parts[reads++]) }; return await new Promise(resolve => { drain = resolve; }); }, async cancel() { cancelled++; } };
  fetch = async (path, options) => { eventFetch = { path, options }; return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => reader } }; };
  renderStatus = () => {}; sync = () => {}; S.token = 'fixture-session'; studioRole = ''; studioEventController = null;
  const stream = studioStartEvents(); for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(S.status.power, 'on'); assert.equal(studioEventsHealthy(), true); assert.equal(eventFetch.path, '/api/events'); assert.equal(eventFetch.options.headers.Authorization, 'Bearer fixture-session');
  studioStopEvents(); assert.equal(eventFetch.options.signal.aborted, true); drain({ done: true }); await stream; assert.equal(cancelled, 1); assert.equal(studioEventsHealthy(), false);
  studioRole = 'guest'; eventFetch = null; await studioStartEvents(); assert.equal(eventFetch, null, 'guest sessions never subscribe'); studioRole = ''; S.token = '';
  fetch = async () => { throw new Error('Disconnected fixture'); }; await studioStartEvents();
  assert.ok([...timers.values()].some(timer => timer.callback === studioStartEvents && timer.delay === 1000), 'a broken stream reconnects with bounded backoff');
  assert.equal(studioEventsHealthy(), false); studioStopEvents();
  document.hidden = true; eventFetch = null; fetch = async () => { eventFetch = true; }; await studioStartEvents(); assert.equal(eventFetch, null, 'hidden pages do not reconnect'); document.hidden = false;

  // Normal account controls use secret inputs and explicit guest button grants.
  wireStudioExtras(); studioLoadUsers = async () => {};
  $('access-name').value = 'living-room'; $('access-pin').value = '482951'; $('access-role').value = 'guest';
  const grants = $('access-actions').querySelectorAll('input'); assert.equal(grants.find(input => input.value === 'power_off').checked, false);
  let savedAccount;
  call = async (method, path, options) => { savedAccount = { method, path, options }; return { message: 'Saved' }; };
  await $('access-form').listeners.submit({ preventDefault() {} });
  assert.equal(savedAccount.path, '/api/access/users/living-room'); assert.equal(savedAccount.options.private, true); assert.equal(savedAccount.options.json.actions.includes('power_off'), false); assert.equal($('access-pin').value, '');
  updateOverlayDraft = realUpdate;
})()`, context);
console.log('check-studio: ok (schema/SVG/QR, bounded history, drag/rebase, keyboard, sharing redaction, metadata forms, serialized live sends, snapshot lifetime, timeline controls)');
