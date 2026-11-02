'use strict';

// Studio interactions share the app's single draft; no second persistence layer.
let studioFrame = 0;
let studioRole = '', studioActions = [];
let studioClipboard = null;
let studioHistory = [], studioHistoryIndex = -1, studioHistoryReplay = false;
let studioDragNode = null, studioSnapshot = null, studioSnapshotTimer = null, studioSnapshotGeneration = 0;
let studioLiveTimer = null, studioLivePending = false, studioLiveSent = '', studioLiveRevision = 0;
let studioEventController = null, studioEventTimer = null, studioEventAt = 0, studioEventBackoff = 1000;
let studioBindingAnchors = [], studioAnchoredCard = null;
const STUDIO_HISTORY_LIMIT = 50;
const STUDIO_SECRET = /token|auth|password|passwd|secret|credential|signature|(?:^|[_-])(?:api[_-]?)?key(?:$|[_-])|^pin$/iu;
const STUDIO_BIND_FIELDS = {
  text: ['text'], badge: ['text'], ticker: ['text'], progress: ['value', 'label'], countdown: ['target', 'label'],
  section: ['title', 'action'], event: ['time', 'text'], stat: ['label', 'left', 'right', 'fraction'], status: ['label', 'detail', 'state'], clock: ['label'],
};
const studioWorkingCard = () => overlayCard.timeline ? overlayCard.timeline[studioFrame].card : overlayCard;
const studioVisibleTheme = () => ({ ...overlayCard.theme, ...studioWorkingCard().theme });
function studioApplyLook(theme) {
  const defaults = { ...Object.fromEntries(Object.entries(OVERLAY_THEME_COLORS).map(([key, spec]) => [key, spec[1]])),
    ...Object.fromEntries(Object.entries(OVERLAY_THEME_RANGES).map(([key, spec]) => [key, spec[4]])), font: 'sans' };
  studioWorkingCard().theme = overlayCard.timeline ? { ...defaults, ...theme } : clone(theme);
  updateOverlayDraft(true);
}
const studioButton = (text, onclick, extra = {}) => h('button', { class: 'btn quiet', type: 'button', text, onclick, ...extra });
const studioField = (label, input, hint = '') => h('label', { class: 'field' }, label, input, hint && h('span', { class: 'hint', text: hint }));
const studioSelect = (values, value, change) => h('select', { onchange: change }, Object.entries(values).map(([key, text]) => h('option', { value: key, text, selected: key === String(value) })));
const studioScalar = value => ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);
const studioKeys = (object, allowed, label) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(label + ' must be an object.');
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(label + ' has no field named ' + key + '.');
};

function studioScalarControl(value, change = () => {}) {
  const box = h('div', { class: 'pair' }), input = h('input', { type: typeof value === 'number' ? 'number' : 'text', value: String(value), 'aria-label': 'Scalar value' });
  const kind = studioSelect({ string: 'Text', number: 'Number', boolean: 'True or false' }, typeof value, () => { input.type = kind.value === 'number' ? 'number' : 'text'; notify(); });
  kind.setAttribute('aria-label', 'Value type');
  const read = () => {
    if (kind.value === 'boolean') { if (!['true', 'false'].includes(input.value)) throw new Error('Enter true or false.'); return input.value === 'true'; }
    if (kind.value === 'number') { if (!input.value.trim() || !Number.isFinite(Number(input.value))) throw new Error('Enter a finite number.'); return Number(input.value); }
    return input.value;
  };
  const notify = () => { try { change(read()); input.removeAttribute('aria-invalid'); } catch (err) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('title', err.message); } };
  input.addEventListener('input', notify);
  box.append(studioField('Value type', kind), studioField('Value', input));
  return { element: box, read };
}

function studioFitTickers(screen) {
  for (const ticker of screen.querySelectorAll('.w-ticker')) {
    const content = ticker.firstElementChild, width = ticker.clientWidth || 0, distance = width + (content.offsetWidth || 0);
    content.style.setProperty('--ticker-start', width + 'px'); content.style.setProperty('--ticker-end', -(content.offsetWidth || 0) + 'px');
    content.style.animationDuration = distance / Number(ticker.dataset.speed) + 's';
  }
}

function checkStudioSvg(source) {
  if (typeof source !== 'string' || !source.length || source.length > 8192 || /[^\x20-\x7e]|&|<!|<\?/u.test(source)) throw new Error('SVG must be at most 8192 characters of inert ASCII geometry, without controls, entities or declarations.');
  const number = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:%|px)?$/u;
  const decimal = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/u;
  const paint = /^(?:none|currentColor|transparent|black|white|red|green|blue|yellow|gray|grey|#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)$/u;
  const rules = { xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/u, fill: paint, stroke: paint, viewBox: /^[-+0-9.eE, ]+$/u,
    points: /^[-+0-9.eE, ]+$/u, d: /^[MmZzLlHhVvCcSsQqTtAa0-9eE+., -]+$/u,
    transform: /^(?: *(?:matrix|translate|scale|rotate|skewX|skewY)\( *[-+0-9.eE, ]+\) *)+$/u,
    'fill-rule': /^(?:nonzero|evenodd)$/u, 'stroke-linecap': /^(?:butt|round|square)$/u, 'stroke-linejoin': /^(?:miter|round|bevel)$/u };
  for (const key of ['width', 'height', 'stroke-width', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry']) rules[key] = number;
  for (const key of ['opacity', 'fill-opacity', 'stroke-opacity']) rules[key] = decimal;
  const stack = []; let rooted = false, pos = 0;
  source = source.trim();
  while (pos < source.length) {
    if (source[pos] === ' ') { pos++; continue; }
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)([^<>]*?)(\/?)>/u.exec(source.slice(pos));
    if (!tag) throw new Error('SVG may contain only geometry elements.');
    const [, closing, name, attrs, selfClosing] = tag;
    if (!['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(name)) throw new Error('Unsupported SVG element: ' + name);
    if (closing) {
      if (selfClosing || attrs.trim() || stack.pop() !== name) throw new Error('SVG elements must be properly nested.');
    } else {
      if (name === 'svg') { if (rooted) throw new Error('SVG needs one root element.'); rooted = true; }
      else if (!stack.length) throw new Error('SVG needs a root svg element.');
      const seen = new Set(); let offset = 0;
      while (offset < attrs.length && attrs.slice(offset).trim()) {
        const attr = /^ +([A-Za-z][A-Za-z0-9-]*) *= *(["'])(.*?)\2/u.exec(attrs.slice(offset));
        if (!attr) throw new Error('SVG attributes must be quoted.');
        const [, key, , value] = attr;
        if (seen.has(key) || !rules[key]?.test(value) || key === 'xmlns' && name !== 'svg') throw new Error('Unsupported SVG attribute: ' + key);
        if (['opacity', 'fill-opacity', 'stroke-opacity'].includes(key) && !inRange(Number(value), 0, 1)) throw new Error('SVG opacity must be 0–1.');
        seen.add(key); offset += attr[0].length;
      }
      if (!selfClosing) stack.push(name);
    }
    pos += tag[0].length;
  }
  if (!rooted || stack.length) throw new Error('SVG needs one complete root element.');
  return source;
}

function checkStudioAnimation(animation) {
  studioKeys(animation, ['enter', 'exit', 'duration_ms'], 'Animation');
  for (const key of ['enter', 'exit']) if (animation[key] !== undefined && !['none', 'fade', 'slide', 'wipe'].includes(animation[key])) throw new Error('Choose a valid animation.');
  if (animation.duration_ms !== undefined && (!Number.isInteger(animation.duration_ms) || !inRange(animation.duration_ms, 0, 2000))) throw new Error('Animation duration must be 0–2000 milliseconds.');
}

function checkStudioCard(card, counter = { n: 0 }, nested = false) {
  studioKeys(card, ['position', 'size', 'seconds', 'theme', 'root', 'regions', 'timeline', 'animation', 'offset', 'behavior', 'bindings'], 'Card');
  if (card.seconds !== undefined && (!Number.isInteger(card.seconds) || !inRange(card.seconds, 0, 300))) throw new Error('Seconds must be a whole number from 0 to 300.');
  if (card.theme !== undefined) checkOverlayTheme(card.theme);
  if (nested && card.bindings !== undefined) throw new Error('Data bindings belong on the whole design, not inside timeline steps.');
  if (card.behavior !== undefined) {
    studioKeys(card.behavior, ['on_foreground', 'ambient_dim'], 'Behavior');
    if (card.behavior.on_foreground !== undefined && !['keep', 'hide', 'shrink'].includes(card.behavior.on_foreground)) throw new Error('Choose what happens when an app is in front.');
    if (card.behavior.ambient_dim !== undefined && typeof card.behavior.ambient_dim !== 'boolean') throw new Error('Ambient dimming must be true or false.');
  }
  if (card.timeline !== undefined) {
    if (nested || card.root !== undefined || card.regions !== undefined || card.position !== undefined || card.size !== undefined || card.offset !== undefined || card.animation !== undefined) throw new Error('A timeline replaces the card layout and cannot nest.');
    if (!Array.isArray(card.timeline) || card.timeline.length < 1 || card.timeline.length > 4) throw new Error('A timeline needs 1–4 steps.');
    for (const frame of card.timeline) {
      studioKeys(frame, ['seconds', 'card'], 'Timeline step');
      if (!Number.isInteger(frame.seconds) || !inRange(frame.seconds, 1, 300)) throw new Error('Each timeline step needs 1–300 seconds.');
      checkStudioCard(frame.card, counter, true);
    }
  } else {
    const multi = card.regions !== undefined;
    if (multi && ['root', 'position', 'size', 'offset', 'animation'].some(key => card[key] !== undefined)) throw new Error('Do not combine regions and a single-card layout.');
    const regions = multi ? card.regions : [card], seen = new Set();
    if (!Array.isArray(regions) || !regions.length || regions.length > 4) throw new Error('Use 1–4 regions.');
    for (const region of regions) {
      if (multi) studioKeys(region, ['position', 'size', 'root', 'offset', 'animation', 'behavior'], 'Region');
      if ((multi || region.position !== undefined) && !Object.hasOwn(OVERLAY_POSITIONS, region.position)) throw new Error('Choose a valid position.');
      if (multi && seen.has(region.position)) throw new Error('Each region needs a different position.');
      seen.add(region.position);
      if (region.size !== undefined && !Object.hasOwn(OVERLAY_SIZES, region.size)) throw new Error('Choose a valid size.');
      if (region.offset !== undefined) {
        studioKeys(region.offset, ['x', 'y'], 'Offset');
        for (const [key, max] of [['x', 1920], ['y', 1080]]) if (region.offset[key] !== undefined && (!Number.isInteger(region.offset[key]) || !inRange(region.offset[key], -max, max))) throw new Error('Offset needs whole TV-pixel coordinates within ±1920 × ±1080.');
      }
      if (region.animation !== undefined) checkStudioAnimation(region.animation);
      if (multi && region.behavior !== undefined) {
        studioKeys(region.behavior, ['on_foreground', 'ambient_dim'], 'Region behavior');
        if (region.behavior.on_foreground !== undefined && !['keep', 'hide', 'shrink'].includes(region.behavior.on_foreground)) throw new Error('Choose a valid foreground behavior.');
        if (region.behavior.ambient_dim !== undefined && typeof region.behavior.ambient_dim !== 'boolean') throw new Error('Ambient dimming must be true or false.');
      }
      checkOverlayTree(region.root, counter);
    }
  }
  if (card.bindings !== undefined) checkStudioBindings(card);
  if (new TextEncoder().encode(JSON.stringify(card)).length > OVERLAY_MAX_BYTES) throw new Error('Use at most 49152 bytes for the whole card.');
  return card;
}

function studioBindingTargets(card = overlayCard) {
  const result = [];
  const add = (target, value) => { if (typeof value === 'string' || typeof value === 'number') result.push({ target, value }); };
  const visit = (node, path) => {
    for (const field of STUDIO_BIND_FIELDS[node.type] || []) if (node[field] !== undefined) add(path + '/' + field, node[field]);
    for (const [i, child] of (node.children || []).entries()) visit(child, path + '/children/' + i);
    if (node.type === 'list') node.items.forEach((value, i) => add(path + '/items/' + i, value));
    if (node.type === 'sparkline') node.points.forEach((value, i) => add(path + '/points/' + i, value));
    for (const key of node.type === 'meta' ? ['items'] : node.type === 'compare' ? ['segments'] : []) node[key].forEach((item, i) => {
      for (const field of node.type === 'compare' ? ['label', 'value', 'fraction'] : ['label', 'value']) add(path + '/' + key + '/' + i + '/' + field, item[field]);
    });
  };
  const walkCard = (value, prefix) => {
    if (value.timeline) value.timeline.forEach((frame, i) => walkCard(frame.card, prefix + '/timeline/' + i + '/card'));
    else if (value.regions) value.regions.forEach((region, i) => visit(region.root, prefix + '/regions/' + i + '/root'));
    else visit(value.root, prefix + '/root');
  };
  walkCard(card, '');
  return result;
}

function checkStudioBindings(card) {
  if (!Array.isArray(card.bindings) || card.bindings.length > 20) throw new Error('Use at most 20 scalar data bindings.');
  const targets = new Set(studioBindingTargets(card).map(item => item.target)), used = new Set();
  for (const binding of card.bindings) {
    studioKeys(binding, ['target', 'source', 'fallback'], 'Binding');
    if (!targets.has(binding.target) || used.has(binding.target)) throw new Error('Each binding must use a different existing text or numeric field.');
    used.add(binding.target);
    studioKeys(binding.source, ['kind', 'url', 'path', 'token', 'allow_private', 'required_secrets'], 'Source');
    const source = binding.source;
    if (!['json', 'homeassistant'].includes(source.kind)) throw new Error('Choose a JSON or Home Assistant source.');
    let url;
    try { url = new URL(source.url); } catch { throw new Error('Use a full HTTP(S) source URL.'); }
    if (typeof source.url !== 'string' || source.url.length > 2048 || /[\x00-\x20\x7f]/u.test(source.url) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.port === '0' || url.username || url.password || url.hash) throw new Error('Source URLs must be HTTP(S), at most 2048 characters, without credentials, whitespace or fragments.');
    const path = source.path === undefined ? '' : source.path;
    if (typeof path !== 'string' || path.length > 500 || /(?:^|[/.])(?:__proto__|constructor|prototype)(?:$|[/.])/u.test(path)) throw new Error('Use a safe dot path or JSON pointer.');
    if (source.allow_private !== undefined && typeof source.allow_private !== 'boolean') throw new Error('Private network permission must be true or false.');
    const missing = source.required_secrets === undefined ? [] : source.required_secrets;
    if (!Array.isArray(missing) || missing.some(key => !['token', 'url'].includes(key))) throw new Error('Invalid missing-secret marker.');
    if (source.token !== undefined && (typeof source.token !== 'string' || !source.token || source.token.length > 4096 || /[\x00-\x1f\x7f]/u.test(source.token))) throw new Error('A source token must be 1–4096 characters without control characters.');
    if (source.kind === 'homeassistant' && !source.token && !missing.includes('token')) throw new Error('A Home Assistant source needs its bearer token.');
    if ('fallback' in binding) {
      if (!studioScalar(binding.fallback)) throw new Error('A fallback must be text, a finite number or true/false.');
      const candidate = clone(card); delete candidate.bindings;
      const parts = binding.target.slice(1).split('/'); let parent = candidate;
      for (const key of parts.slice(0, -1)) parent = parent[key];
      const key = parts.at(-1), old = parent[key]; let value = binding.fallback;
      if (typeof old === 'string') value = String(value);
      else if (typeof old === 'number' && typeof value === 'string') {
        if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value) || !Number.isFinite(Number(value))) throw new Error('Numeric fields need a finite decimal fallback.');
        value = Number(value);
      }
      parent[key] = value; checkStudioCard(candidate);
    }
  }
}

function studioCaptureBindingAnchors() {
  studioAnchoredCard = overlayCard;
  studioBindingAnchors = (overlayCard.bindings || []).map(binding => {
    const parts = binding.target.slice(1).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
    let parent = overlayCard, widget = null, widgetIndex = 0;
    for (const [index, key] of parts.slice(0, -1).entries()) {
      parent = parent?.[key];
      if (parent?.type) { widget = parent; widgetIndex = index + 1; }
    }
    return { binding, parent, key: parts.at(-1), widget, tail: parts.slice(widgetIndex) };
  });
}
function studioRebaseBindings() {
  if (studioAnchoredCard !== overlayCard || !overlayCard.bindings) return;
  const paths = new Map();
  const visit = (value, path) => {
    if (!value || typeof value !== 'object') return;
    paths.set(value, path);
    for (const [key, child] of Object.entries(value)) if (key !== 'bindings') visit(child, path + '/' + key.replace(/~/gu, '~0').replace(/\//gu, '~1'));
  };
  visit(overlayCard, '');
  for (const { binding, parent, key, widget, tail } of studioBindingAnchors) {
    if (!overlayCard.bindings.includes(binding)) continue;
    if (paths.has(parent) && Object.hasOwn(parent, key)) binding.target = paths.get(parent) + '/' + key;
    else if (paths.has(widget) && tail.length === 2 && ['items', 'points'].includes(tail[0]) && studioScalar(widget[tail[0]]?.[tail[1]])) binding.target = paths.get(widget) + '/' + tail.join('/');
    else overlayCard.bindings.splice(overlayCard.bindings.indexOf(binding), 1);
  }
  if (!overlayCard.bindings.length) delete overlayCard.bindings;
}

function studioRecordDraft() {
  if (studioHistoryReplay) return;
  studioRebaseBindings();
  studioCaptureBindingAnchors();
  const value = JSON.stringify(overlayBody());
  if (studioHistory[studioHistoryIndex] === value) return;
  studioHistory.splice(studioHistoryIndex + 1);
  studioHistory.push(value);
  if (studioHistory.length > STUDIO_HISTORY_LIMIT) studioHistory.shift();
  studioHistoryIndex = studioHistory.length - 1;
  studioSyncHistory();
}
function studioSyncHistory() {
  if ($('ov-undo')) $('ov-undo').disabled = studioHistoryIndex <= 0 || overlayValidationBusy || overlayJsonDirty;
  if ($('ov-redo')) $('ov-redo').disabled = studioHistoryIndex >= studioHistory.length - 1 || overlayValidationBusy || overlayJsonDirty;
}
function studioUndo(direction) {
  const next = studioHistoryIndex + direction;
  if (next < 0 || next >= studioHistory.length || overlayValidationBusy || overlayJsonDirty) return;
  studioHistoryIndex = next;
  overlayCard = JSON.parse(studioHistory[next]);
  studioFrame = Math.min(studioFrame, (overlayCard.timeline?.length || 1) - 1);
  overlaySelected = overlayRegions()[0].root;
  studioHistoryReplay = true;
  studioCaptureBindingAnchors();
  updateOverlayDraft(true);
  studioHistoryReplay = false;
  studioSyncHistory();
}

function studioMoveWidget(source, target, into = false) {
  const from = findOverlayNode(source), to = findOverlayNode(target);
  if (!from?.parent || !to || source === target) return false;
  const contains = node => node === target || (node.children || []).some(contains);
  if (contains(source)) return false;
  const parent = into && target.children ? target : to.parent;
  if (!parent || parent !== from.parent && parent.children.length >= (parent.type === 'row' ? 10 : 20) || from.parent !== parent && from.parent.children.length <= 1) return false;
  const before = clone(overlayBody());
  studioCaptureBindingAnchors();
  from.parent.children.splice(from.index, 1);
  const index = into ? parent.children.length : parent.children.indexOf(target);
  parent.children.splice(index, 0, source);
  studioRebaseBindings();
  try { checkOverlayCard(overlayBody()); }
  catch (err) { overlayCard = before; overlaySelected = overlayRegions()[0].root; updateOverlayDraft(true); result($('ov-builder-msg'), err.message, 'error'); return false; }
  overlaySelected = source;
  updateOverlayDraft(true);
  return true;
}
function wireStudioWidgetDrag(box, node) {
  box.draggable = true;
  box.addEventListener('dragstart', event => { event.stopPropagation(); studioDragNode = node; event.dataTransfer.setData('text/plain', 'studio-widget'); event.dataTransfer.effectAllowed = 'move'; });
  box.addEventListener('dragover', event => { if (studioDragNode && studioDragNode !== node) { event.preventDefault(); event.stopPropagation(); } });
  box.addEventListener('drop', event => { if (!studioDragNode) return; event.preventDefault(); event.stopPropagation(); studioMoveWidget(studioDragNode, node, event.shiftKey); studioDragNode = null; });
  box.addEventListener('dragend', () => { studioDragNode = null; });
}
function studioInsertWidget(node) {
  const before = clone(overlayBody()), target = overlayAddTarget();
  studioCaptureBindingAnchors();
  if (target.group) target.group.children.splice(target.node.children ? target.group.children.length : target.index + 1, 0, node);
  else target.region.root = { type: 'stack', children: [target.node, node] };
  studioRebaseBindings();
  try { checkOverlayCard(overlayBody()); }
  catch (err) { overlayCard = before; overlaySelected = overlayRegions()[0].root; updateOverlayDraft(true); result($('ov-builder-msg'), err.message, 'error'); return false; }
  overlaySelected = node;
  updateOverlayDraft(true);
  return true;
}
function studioKeyboard(event) {
  if (S.view !== 'show' || event.altKey || event.target.closest?.('input, textarea, select, [contenteditable], dialog') || document.querySelector('dialog[open]') || overlayJsonDirty || overlayValidationBusy) return;
  const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase(), found = findOverlayNode(overlaySelected);
  if (command && key === 'z') { event.preventDefault(); studioUndo(event.shiftKey ? 1 : -1); }
  else if (command && key === 'y') { event.preventDefault(); studioUndo(1); }
  else if (command && key === 'c' && found) { event.preventDefault(); studioClipboard = clone(found.node); say('Widget copied.'); }
  else if (command && key === 'v' && studioClipboard) { event.preventDefault(); studioInsertWidget(clone(studioClipboard)); }
  else if (!command && ['delete', 'backspace'].includes(key) && found?.parent && found.parent.children.length > 1) {
    event.preventDefault(); found.parent.children.splice(found.index, 1); overlaySelected = found.parent; updateOverlayDraft(true);
  } else if (!command && ['arrowup', 'arrowdown'].includes(key) && found?.parent) {
    const next = found.index + (key === 'arrowup' ? -1 : 1);
    if (next >= 0 && next < found.parent.children.length) { event.preventDefault(); [found.parent.children[next], found.parent.children[found.index]] = [found.node, found.parent.children[next]]; updateOverlayDraft(true); }
  }
}

function studioRegionExtras(region) {
  const box = h('details', {}, h('summary', { text: 'Motion and exact placement' }));
  const offset = region.offset || { x: 0, y: 0 };
  for (const [axis, max] of [['x', 1920], ['y', 1080]]) {
    const input = h('input', { type: 'number', min: -max, max, step: 1, value: offset[axis] ?? 0 });
    input.addEventListener('input', () => { region.offset = { ...(region.offset || offset), [axis]: Number(input.value) }; updateOverlayDraft(false); });
    box.append(studioField(axis === 'x' ? 'Horizontal offset (TV pixels)' : 'Vertical offset (TV pixels)', input));
  }
  box.append(h('p', { class: 'hint', text: 'Drag a floating region in the preview, or enter offsets. Bars and side panels stay docked. Use Move up/down or arrow keys for widgets; drag before another widget, or Shift-drop inside a group.' }));
  for (const key of ['enter', 'exit']) box.append(studioField(key === 'enter' ? 'Enter animation' : 'Exit animation', studioSelect({ none: 'None', fade: 'Fade', slide: 'Slide', wipe: 'Wipe' }, region.animation?.[key] || 'none', event => {
    region.animation = { ...region.animation, [key]: event.target.value }; updateOverlayDraft(false);
  })));
  const duration = h('input', { type: 'number', min: 0, max: 2000, step: 1, value: region.animation?.duration_ms ?? 250 });
  duration.addEventListener('input', () => { region.animation = { ...region.animation, duration_ms: Number(duration.value) }; updateOverlayDraft(false); });
  box.append(studioField('Animation duration (milliseconds)', duration));
  if (region !== overlayCard) {
    const apply = (key, value) => { region.behavior ??= {}; if (value === '') delete region.behavior[key]; else region.behavior[key] = value; if (!Object.keys(region.behavior).length) delete region.behavior; updateOverlayDraft(false); };
    box.append(studioField('This area when another app is in front', studioSelect({ '': 'Use whole-card behavior', keep: 'Keep visible', hide: 'Hide', shrink: 'Shrink' }, region.behavior?.on_foreground || '', event => apply('on_foreground', event.target.value))),
      studioField('Ambient dimming for this area', studioSelect({ '': 'Use whole-card behavior', true: 'Use ambient sensor', false: 'Do not dim' }, region.behavior?.ambient_dim ?? '', event => apply('ambient_dim', event.target.value === '' ? '' : event.target.value === 'true'))));
  }
  return box;
}
function studioPositionRegion(article, region, stage) {
  if (region.offset && !['top', 'bottom', 'left', 'right'].includes(region.position)) {
    article.style.setProperty('--offset-x', (region.offset.x || 0) + 'px'); article.style.setProperty('--offset-y', (region.offset.y || 0) + 'px');
  }
  if (stage.id !== 'ov-preview' || ['top', 'bottom', 'left', 'right'].includes(region.position)) return;
  article.classList.add('tv-draggable');
  article.addEventListener('pointerdown', event => {
    if (event.button !== 0 || overlayValidationBusy || overlayJsonDirty) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, offset: { x: region.offset?.x || 0, y: region.offset?.y || 0 } };
    const scale = stage.getBoundingClientRect().width / 1920 * (studioWorkingCard().theme?.scale ?? overlayCard.theme?.scale ?? 1);
    article.setPointerCapture(event.pointerId);
    const move = e => {
      const x = Math.max(-1920, Math.min(1920, Math.round(start.offset.x + (e.clientX - start.x) / scale)));
      const y = Math.max(-1080, Math.min(1080, Math.round(start.offset.y + (e.clientY - start.y) / scale)));
      region.offset = { x, y }; article.style.setProperty('--offset-x', x + 'px'); article.style.setProperty('--offset-y', y + 'px');
    };
    const done = e => { article.removeEventListener('pointermove', move); article.removeEventListener('pointerup', done); article.removeEventListener('pointercancel', cancel); if (article.hasPointerCapture(e.pointerId)) article.releasePointerCapture(e.pointerId); updateOverlayDraft(true); };
    const cancel = e => { region.offset = start.offset; done(e); };
    article.addEventListener('pointermove', move); article.addEventListener('pointerup', done); article.addEventListener('pointercancel', cancel);
  });
}
function studioPreviewSvg(el, source) {
  checkStudioSvg(source);
  const stack = [el];
  for (const tag of source.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)([^<>]*?)(\/?)>/gu)) {
    if (tag[1]) { stack.pop(); continue; }
    const node = document.createElementNS(SVG, tag[2]);
    for (const attr of tag[3].matchAll(/ +([A-Za-z][A-Za-z0-9-]*) *= *(["'])(.*?)\2/gu)) node.setAttribute(attr[1], attr[3]);
    stack.at(-1).append(node);
    if (!tag[4]) stack.push(node);
  }
}
function studioPreviewQr(el, text) {
  if (typeof qrcode !== 'function') { el.append(h('span', { text: 'QR code · loads on TV' })); return; }
  const code = qrcode(0, 'L'); code.addData(text); code.make();
  const count = code.getModuleCount(), svg = document.createElementNS(SVG, 'svg'), path = document.createElementNS(SVG, 'path');
  svg.setAttribute('viewBox', `0 0 ${count + 8} ${count + 8}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code');
  let data = '';
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (code.isDark(row, col)) data += `M${col + 4} ${row + 4}h1v1h-1z`;
  path.setAttribute('d', data); svg.append(path); el.append(svg);
}

function studioReadPresets() {
  try { const data = JSON.parse(localStorage.getItem('webos-foundry-widget-presets') || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch { return {}; }
}
function studioPresetControls(node) {
  const name = h('input', { type: 'text', maxlength: 60, placeholder: 'Widget preset name', 'aria-label': 'Widget preset name' });
  const box = h('details', {}, h('summary', { text: 'Keep this widget as a preset' }), studioField('Preset name', name));
  box.append(studioButton('Save widget preset', () => {
    try {
      checkOverlayTree(node); if (!name.value.trim()) throw new Error('Name the preset first.');
      const presets = studioReadPresets(), key = name.value.trim();
      const save = () => {
        try {
          if (!Object.hasOwn(presets, key) && Object.keys(presets).length >= 30) throw new Error('Keep at most 30 widget presets; remove one first.');
          Object.defineProperty(presets, key, { value: studioRedact(node), enumerable: true, configurable: true, writable: true });
          localStorage.setItem('webos-foundry-widget-presets', JSON.stringify(presets)); renderOverlayBuilder(); say('Widget preset saved on this device.');
        } catch (err) { say(err.message, 'error'); }
      };
      if (Object.hasOwn(presets, key)) askInPlace(box, 'Replace this widget preset?', 'Replace', save); else save();
    } catch (err) { say(err.message, 'error'); }
  }));
  return box;
}
function studioPresetPalette() {
  const box = h('details', { class: 'widget-palette' }, h('summary', { text: 'Your widget presets' })), presets = studioReadPresets();
  if (!Object.keys(presets).length) box.append(h('p', { class: 'hint', text: 'Save any selected widget or group from its inspector. Presets stay on this device and contain no data-source credentials.' }));
  for (const [name, node] of Object.entries(presets)) {
    try { checkOverlayTree(node); } catch { continue; }
    box.append(h('div', { class: 'row' }, studioButton('Add ' + name, () => studioInsertWidget(clone(node))), studioButton('Remove ' + name, () => {
      try { delete presets[name]; localStorage.setItem('webos-foundry-widget-presets', JSON.stringify(presets)); renderOverlayBuilder(); } catch (err) { say(err.message, 'error'); }
    })));
  }
  return box;
}

function studioClearSnapshot() {
  studioSnapshotGeneration++; clearTimeout(studioSnapshotTimer);
  $('ov-preview')?.style.removeProperty('--tv-snapshot');
  if (studioSnapshot) URL.revokeObjectURL(studioSnapshot);
  studioSnapshot = null;
  if ($('ov-snapshot-clear')) $('ov-snapshot-clear').disabled = true;
}
async function studioCaptureSnapshot() {
  const generation = ++studioSnapshotGeneration, button = $('ov-snapshot');
  button.disabled = true; button.dataset.state = 'loading';
  try {
    const blob = await call('GET', '/api/screenshot?width=1920&format=jpg', { private: true });
    if (!(blob instanceof Blob)) throw new Error('The server did not return an image.');
    if (generation !== studioSnapshotGeneration || document.hidden || S.view !== 'show') return;
    studioClearSnapshot(); studioSnapshot = URL.createObjectURL(blob);
    $('ov-preview').style.setProperty('--tv-snapshot', `url("${studioSnapshot}")`);
    $('ov-snapshot-clear').disabled = false;
    studioSnapshotTimer = setTimeout(studioClearSnapshot, 300000);
    result($('ov-preview-msg'), 'HDMI snapshot captured. It is only held in this tab for five minutes; it is not saved, exported or included in thumbnails.', 'ok');
  } catch (err) { result($('ov-preview-msg'), err.message, 'error'); }
  finally { button.disabled = false; delete button.dataset.state; }
}
function studioCancelLive(disable = false) {
  clearTimeout(studioLiveTimer); studioLiveTimer = null; studioLivePending = false; studioLiveRevision++;
  if (disable && $('ov-live-edit')) $('ov-live-edit').checked = false;
}
function studioQueueLive() {
  studioSyncHistory();
  if (!$('ov-live-edit')?.checked || document.hidden || S.view !== 'show' || overlayError || overlayJsonDirty || overlayValidationBusy || S.reserved || S.status?.power === 'off') return;
  const body = JSON.stringify(overlayBody());
  if (body === studioLiveSent) return;
  studioLivePending = true;
  clearTimeout(studioLiveTimer);
  studioLiveTimer = setTimeout(studioFlushLive, 650);
}
async function studioFlushLive() {
  studioLiveTimer = null;
  if (!studioLivePending || !$('ov-live-edit').checked || document.hidden || S.view !== 'show' || overlayError || overlayJsonDirty || overlayValidationBusy || S.reserved) return;
  if (S.overlayBusy) return; // The finishing send schedules the newest full draft.
  const revision = studioLiveRevision, body = JSON.stringify(overlayBody());
  studioLivePending = false; S.overlayBusy = true; syncNotify();
  result($('ov-live-msg'), 'Sending latest draft…');
  try {
    let card = JSON.parse(body);
    if (card.bindings) card = (await call('POST', '/api/designs/resolve', { json: card, private: true })).card;
    if (revision !== studioLiveRevision || !$('ov-live-edit').checked || body !== JSON.stringify(overlayBody()) || overlayJsonDirty || overlayError || overlayValidationBusy) return;
    await call('POST', '/api/overlay', { json: card, private: true });
    if (revision === studioLiveRevision) { studioLiveSent = body; result($('ov-live-msg'), 'Latest draft sent. Live editing is on.', 'ok'); }
  } catch (err) {
    if (revision === studioLiveRevision) { $('ov-live-edit').checked = false; result($('ov-live-msg'), 'Live editing paused: ' + err.message + '. Enable it to retry.', 'error'); }
  } finally { S.overlayBusy = false; syncNotify(); studioQueueLive(); }
}

function renderStudioExtras() {
  if (!$('ov-timeline')) return;
  const timeline = $('ov-timeline');
  timeline.replaceChildren(h('h3', { text: 'Sequence and screen behavior' }));
  $('ov-duration-help').textContent = overlayCard.timeline ? 'Optional overall timeline limit: leave empty or use 0 to play every step. Each step has its own duration.' : '0 keeps the card on screen until you hide it. Up to 300 seconds; empty uses 8 seconds.';
  if (!overlayCard.timeline) timeline.append(studioButton('Make a timeline', () => {
    const card = clone(studioWorkingCard()); delete card.bindings; delete card.seconds; delete card.theme; delete card.behavior;
    const { theme, behavior, bindings } = overlayCard;
    overlayCard = { ...(theme ? { theme } : {}), ...(behavior ? { behavior } : {}),
      ...(bindings ? { bindings: bindings.map(binding => ({ ...binding, target: '/timeline/0/card' + binding.target })) } : {}), timeline: [{ seconds: 8, card }] };
    studioFrame = 0; updateOverlayDraft(true);
  }));
  else {
    overlayCard.timeline.forEach((frame, i) => {
      const seconds = h('input', { type: 'number', min: 1, max: 300, step: 1, value: frame.seconds, 'aria-label': 'Seconds for timeline step ' + (i + 1) });
      seconds.addEventListener('input', () => { frame.seconds = Number(seconds.value); updateOverlayDraft(false); });
      timeline.append(h('div', { class: 'row' }, studioButton('Edit step ' + (i + 1), () => { studioFrame = i; overlaySelected = overlayRegions()[0].root; updateOverlayDraft(true); }, { 'aria-pressed': String(i === studioFrame) }), studioField('Seconds', seconds),
        studioButton('Move earlier', () => { studioCaptureBindingAnchors(); [overlayCard.timeline[i - 1], overlayCard.timeline[i]] = [frame, overlayCard.timeline[i - 1]]; studioFrame = i - 1; updateOverlayDraft(true); }, { disabled: i === 0 }),
        studioButton('Remove step', () => askInPlace(timeline, 'Remove this timeline step and its widgets? Its related bindings will be removed.', 'Remove', () => { studioCaptureBindingAnchors(); overlayCard.timeline.splice(i, 1); studioFrame = Math.min(studioFrame, overlayCard.timeline.length - 1); updateOverlayDraft(true); }), { disabled: overlayCard.timeline.length <= 1 })));
    });
    timeline.append(studioButton('Add timeline step', () => {
      overlayCard.timeline.push({ seconds: 8, card: { position: 'top-right', size: 'm', root: newOverlayNode('stack') } }); studioFrame = overlayCard.timeline.length - 1; updateOverlayDraft(true);
    }, { disabled: overlayCard.timeline.length >= 4 || overlayCardCount() + 2 > OVERLAY_MAX_NODES }), studioButton('Keep this step as one card', () => askInPlace(timeline, 'Remove the timeline and keep only the step being edited? Other steps and their bindings will be removed.', 'Keep this step', () => {
      const frame = clone(studioWorkingCard()), prefix = '/timeline/' + studioFrame + '/card';
      const bindings = (overlayCard.bindings || []).filter(binding => binding.target.startsWith(prefix + '/')).map(binding => ({ ...binding, target: binding.target.slice(prefix.length) }));
      overlayCard = { ...overlayCard, ...frame }; delete overlayCard.timeline; if (bindings.length) overlayCard.bindings = bindings; else delete overlayCard.bindings;
      studioFrame = 0; updateOverlayDraft(true);
    })));
    timeline.append(h('p', { class: 'hint', text: 'Look controls below change the step being edited.' }), studioButton('Use this look for every step', () => {
      overlayCard.theme = studioVisibleTheme(); for (const frame of overlayCard.timeline) delete frame.card.theme; updateOverlayDraft(true);
    }));
  }
  const behavior = overlayCard.behavior || {};
  const foreground = studioSelect({ keep: 'Keep full card', hide: 'Hide while another app is in front', shrink: 'Shrink while another app is in front' }, behavior.on_foreground || 'keep', event => { overlayCard.behavior = { ...overlayCard.behavior, on_foreground: event.target.value }; updateOverlayDraft(false); });
  const dim = h('input', { type: 'checkbox', checked: behavior.ambient_dim === true });
  dim.addEventListener('change', () => { overlayCard.behavior = { ...overlayCard.behavior, ambient_dim: dim.checked }; updateOverlayDraft(false); });
  timeline.append(studioField('When another app comes to the foreground', foreground), h('label', { class: 'check' }, dim, 'Dim the card with the TV’s ambient-light sensor'), h('p', { class: 'hint', text: 'Ambient dimming uses the TV’s available sensor, without changing picture settings. The preview shows the step you are editing; the TV plays the sequence.' }));
  renderStudioBindings();
}

function renderStudioBindings() {
  const host = $('ov-bindings');
  host.replaceChildren(h('summary', { text: 'Live values from JSON or Home Assistant' }), h('p', { class: 'hint', text: 'Only the chosen scalar field is replaced, when resolving or showing this design. URLs are fetched by your server. Private-network access is off unless you allow it. Tokens are not included in exports.' }));
  const targets = studioBindingTargets(), bindings = overlayCard.bindings || [];
  bindings.forEach((binding, i) => {
    const box = h('fieldset', {}, h('legend', { text: 'Data value ' + (i + 1) }));
    const target = studioSelect(Object.fromEntries(targets.map(item => [item.target, item.target + ' · ' + String(item.value).slice(0, 45)])), binding.target, event => { binding.target = event.target.value; studioCaptureBindingAnchors(); updateOverlayDraft(false); });
    const source = binding.source;
    box.append(studioField('Replace field', target), studioField('Source', studioSelect({ json: 'JSON URL', homeassistant: 'Home Assistant JSON API' }, source.kind, event => { source.kind = event.target.value; updateOverlayDraft(false); })));
    for (const [key, label, type] of [['url', 'HTTP(S) source URL', 'url'], ['path', 'Value path (dot path or /JSON/pointer)', 'text'], ['token', 'Bearer token (optional)', 'password']]) {
      const input = h('input', { type, value: source[key] || '', autocomplete: 'off', spellcheck: false });
      input.addEventListener('input', () => {
        if (key === 'token' && !input.value) delete source.token; else source[key] = input.value;
        if (source.required_secrets && input.value) {
          source.required_secrets = source.required_secrets.filter(required => required !== key);
          if (!source.required_secrets.length) delete source.required_secrets;
        }
        updateOverlayDraft(false);
      });
      box.append(studioField(label, input));
    }
    if (source.required_secrets?.length) box.append(h('p', { class: 'hint', text: 'This imported source needs its secret re-entered: ' + source.required_secrets.join(', ') }));
    const privateAccess = h('input', { type: 'checkbox', checked: source.allow_private === true });
    privateAccess.addEventListener('change', () => { source.allow_private = privateAccess.checked; updateOverlayDraft(false); });
    box.append(h('label', { class: 'check' }, privateAccess, 'Allow this source to reach private/local network addresses'));
    const fallbackToggle = h('input', { type: 'checkbox', checked: 'fallback' in binding });
    const fallback = studioScalarControl('fallback' in binding ? binding.fallback : targets.find(item => item.target === binding.target)?.value ?? '', value => { if (fallbackToggle.checked) { binding.fallback = value; updateOverlayDraft(false); } });
    fallback.element.hidden = !fallbackToggle.checked;
    fallbackToggle.addEventListener('change', () => { fallback.element.hidden = !fallbackToggle.checked; if (!fallbackToggle.checked) delete binding.fallback; else binding.fallback = fallback.read(); updateOverlayDraft(false); });
    box.append(h('label', { class: 'check' }, fallbackToggle, 'Use an explicit fallback if the source fails'), fallback.element, studioButton('Remove data value', () => { bindings.splice(i, 1); if (!bindings.length) delete overlayCard.bindings; updateOverlayDraft(true); }));
    host.append(box);
  });
  host.append(studioButton('Add data value', () => {
    const target = targets.find(item => !bindings.some(binding => binding.target === item.target)); if (!target) return;
    overlayCard.bindings ??= []; overlayCard.bindings.push({ target: target.target, source: { kind: 'json', url: '', path: '' } }); updateOverlayDraft(true);
  }, { disabled: bindings.length >= 20 || !targets.some(item => !bindings.some(binding => binding.target === item.target)) }), studioButton('Resolve values into preview', async () => {
    const before = JSON.stringify(overlayBody());
    try { const reply = await call('POST', '/api/designs/resolve', { json: overlayBody(), private: true }); if (before !== JSON.stringify(overlayBody())) throw new Error('Draft changed. Resolve again.'); checkOverlayCard(reply.card); renderTvStage($('ov-preview'), reply.card); result($('ov-bindings-msg'), 'Resolved preview only. Your source configuration is unchanged.', 'ok'); }
    catch (err) { result($('ov-bindings-msg'), err.message, 'error'); }
  }));
}

function studioMetadataInput(spec, stored) {
  const value = stored ?? spec.default ?? '';
  if (spec.type === 'select' && spec.choices) return h('select', { required: spec.required === true }, spec.choices.map(choice => h('option', { value: choice.value ?? choice, text: choice.label ?? choice, selected: (choice.value ?? choice) === value })));
  if (spec.type === 'boolean') return h('input', { type: 'checkbox', checked: value === true });
  return h('input', { type: spec.type === 'secret' ? 'password' : spec.type === 'number' ? 'number' : spec.key.includes('url') ? 'url' : 'text', value,
    required: spec.required === true, min: spec.min, max: spec.max, step: spec.step, autocomplete: spec.type === 'secret' ? 'off' : null });
}

async function studioLoadThemes() {
  if (!$('ov-saved-themes') || studioRole === 'guest') return;
  try {
    const { themes } = await call('GET', '/api/themes', { private: true });
    $('ov-saved-themes').replaceChildren(...Object.entries(themes).map(([name, theme]) => h('div', { class: 'row' }, studioButton('Use ' + name, () => studioApplyLook(theme)), studioButton('Delete ' + name, () => askInPlace($('ov-saved-themes'), 'Delete the saved look ' + name + '? Existing designs keep their colors.', 'Delete', async () => {
      try { await call('DELETE', '/api/themes/' + encodeURIComponent(name)); studioLoadThemes(); } catch (err) { result($('ov-theme-msg'), err.message, 'error'); }
    })))));
    if (!Object.keys(themes).length) $('ov-saved-themes').append(h('p', { class: 'hint', text: 'No saved looks yet.' }));
    $('ov-saved-themes')._themes = themes;
  } catch (err) { result($('ov-theme-msg'), 'Could not load saved looks: ' + err.message, 'error'); }
}
async function studioSaveTheme() {
  const name = $('ov-theme-name').value.trim();
  if (!name || name.length > 60) return result($('ov-theme-msg'), 'Name this look using 1–60 characters.', 'error');
  const save = async () => { try { const theme = studioVisibleTheme(); checkOverlayTheme(theme); await call('PUT', '/api/themes/' + encodeURIComponent(name), { json: theme }); result($('ov-theme-msg'), 'Look saved on this server.', 'ok'); await studioLoadThemes(); } catch (err) { result($('ov-theme-msg'), err.message, 'error'); } };
  if (Object.hasOwn($('ov-saved-themes')._themes || {}, name)) askInPlace($('ov-theme-form'), 'Replace the saved look ' + name + '?', 'Replace', save); else await save();
}

function studioRedact(value) {
  const visit = (item, key = '') => {
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (item && typeof item === 'object') {
      const result = {};
      for (const [name, child] of Object.entries(item)) {
        if (name !== 'required_secrets' && STUDIO_SECRET.test(name)) continue;
        if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
        result[name] = visit(child, name);
      }
      return result;
    }
    if (typeof item === 'string' && (/url|src/iu.test(key) || /^https?:\/\//iu.test(item))) {
      try {
        const url = new URL(item);
        if (['http:', 'https:'].includes(url.protocol)) {
          let changed = !!(url.username || url.password);
          url.username = ''; url.password = '';
          for (const name of new Set(url.searchParams.keys())) if (STUDIO_SECRET.test(name)) { url.searchParams.delete(name); changed = true; }
          if (changed) { url.hash = ''; return url.href; }
        }
      } catch { /* Text is not a URL. */ }
    }
    return item;
  };
  const redacted = visit(value);
  const mark = (source, copy) => {
    if (!source || typeof source !== 'object' || !copy || typeof copy !== 'object') return;
    if (source.source && copy.source) {
      const required = new Set(source.source.required_secrets || []);
      if (source.source.token) required.add('token');
      if (source.source.url !== copy.source.url) required.add('url');
      if (required.size) copy.source.required_secrets = [...required];
    }
    for (const key of Object.keys(source)) mark(source[key], copy[key]);
  };
  mark(value, redacted);
  return redacted;
}
function studioThumbnail(card) {
  const theme = card.theme || {}, regions = overlayRegions(card);
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="#111a17"/>'];
  for (const region of regions) {
    const pos = region.position || 'top-right', edge = ['top', 'bottom', 'left', 'right'].includes(pos);
    const w = ['top', 'bottom'].includes(pos) ? 480 : 124, h = ['left', 'right'].includes(pos) ? 270 : 66;
    const x = pos.includes('right') || pos === 'right' ? 480 - w - (edge ? 0 : 14) : pos === 'center' ? (480 - w) / 2 : edge ? 0 : 14;
    const y = pos.includes('bottom') ? 270 - h - (edge ? 0 : 14) : pos === 'center' ? (270 - h) / 2 : edge ? 0 : 14;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${edge ? 0 : 4}" fill="${theme.surface || '#191c22'}"/>`);
    let row = 0;
    const visit = node => {
      if (row < 5 && (node.text || node.title || node.label)) {
        const length = Math.min(w - 16, Math.max(12, String(node.text || node.title || node.label).length * 2));
        parts.push(`<rect x="${x + 8}" y="${y + 10 + row * 10}" width="${length}" height="3" fill="${row ? theme.muted || '#c4c9d2' : theme.text || '#f0f2f5'}"/>`); row++;
      }
      (node.children || []).forEach(visit);
    };
    visit(region.root);
  }
  return parts.join('') + '</svg>';
}
function studioBundle(card, name) {
  const safe = studioRedact(card), required_secrets = [];
  (safe.bindings || []).forEach((binding, i) => (binding.source.required_secrets || []).forEach(key => required_secrets.push('/bindings/' + i + '/source/' + key)));
  return { format: 'webos-foundry-design', version: 1, name, card: safe, thumbnail: studioThumbnail(safe), ...(required_secrets.length ? { required_secrets } : {}) };
}
async function studioExportSaved(name) {
  try { const bundle = await call('GET', '/api/designs/' + encodeURIComponent(name) + '/export', { private: true }); if (!bundle.thumbnail) bundle.thumbnail = studioThumbnail(bundle.card); downloadJson(bundle, name); }
  catch (err) { result($('designs-msg'), err.message, 'error'); }
}
async function studioImport(file) {
  const host = $('ov-import-preview'); host.replaceChildren();
  try {
    if (file.size > 512 * 1024) throw new Error('Choose a design file smaller than 512 KB.');
    const parsed = JSON.parse(await file.text()), bundle = parsed.format === 'webos-foundry-design' ? parsed : studioBundle(checkOverlayCard(parsed), file.name.replace(/\.json$/iu, ''));
    if (bundle.format !== 'webos-foundry-design' || bundle.version !== 1) throw new Error('This design bundle version is not supported.');
    checkOverlayCard(bundle.card);
    const stage = h('div', { class: 'tv-stage tv-thumb', 'aria-label': 'Imported design preview' }); renderTvStage(stage, bundle.card);
    const name = h('input', { type: 'text', value: String(bundle.name || 'Imported design').slice(0, 60), maxlength: 60, required: true });
    host.append(h('h3', { text: 'Preview imported design' }), stage, h('p', { class: 'hint', text: designSummary(bundle.card) + '. Nothing has been saved or sent. Imported credentials may need re-entry.' }), studioField('Design name', name),
      studioButton('Use as draft', () => askReplaceDraft(host, 'this imported card', async () => { if (await applyOverlayJson(JSON.stringify(bundle.card), $('ov-paste-msg'))) { $('design-name').value = name.value.trim(); host.replaceChildren(); } })),
      studioButton('Import to My designs', async () => {
        if (!name.value.trim()) return result($('ov-paste-msg'), 'Name the imported design first.', 'error');
        try {
          const targetName = name.value.trim();
          const { designs } = await call('GET', '/api/designs', { private: true });
          const save = async overwrite => {
            try { await call('POST', '/api/designs/import', { json: { bundle, name: targetName, overwrite }, private: true }); await loadAutomation('designs'); host.replaceChildren(); result($('ov-paste-msg'), 'Design imported. Load it from My designs to edit.', 'ok'); }
            catch (err) { result($('ov-paste-msg'), err.message, 'error'); }
          };
          if (Object.hasOwn(designs, targetName)) askInPlace(host, 'Overwrite the saved design ' + targetName + '? Its previous version stays in history.', 'Overwrite', () => save(true)); else await save(false);
        } catch (err) { result($('ov-paste-msg'), err.message, 'error'); }
      }), studioButton('Cancel import', () => host.replaceChildren()));
  } catch (err) { result($('ov-paste-msg'), 'Could not import ' + file.name + ': ' + err.message, 'error'); }
}
async function studioVersions(name, row) {
  row.querySelector('.design-versions')?.remove();
  const host = h('div', { class: 'design-versions' }, h('p', { text: 'Loading versions…' })); row.append(host);
  try {
    const { versions } = await call('GET', '/api/designs/' + encodeURIComponent(name) + '/history', { private: true });
    host.replaceChildren(h('h3', { text: 'Saved versions' }), studioButton('Close versions', () => host.remove()));
    if (!versions.length) host.append(h('p', { class: 'hint', text: 'No previous versions yet. A version is kept when you replace a design.' }));
    for (const version of versions) {
      const stage = h('div', { class: 'tv-stage tv-thumb', 'aria-hidden': true }); renderTvStage(stage, version.card);
      host.append(h('div', { class: 'version-row' }, stage, h('p', { text: new Date(version.created_at).toLocaleString() }), studioButton('Load version as draft', () => askReplaceDraft(host, 'this version', () => { setOverlayCard(clone(version.card)); $('design-name').value = name; showStudioStep('design'); })), studioButton('Restore saved version', () => askInPlace(host, 'Restore this saved version? The current design will be kept in history.', 'Restore', async () => {
        try { const reply = await call('POST', '/api/designs/' + encodeURIComponent(name) + '/restore', { json: { id: version.id }, private: true }); await loadAutomation('designs'); result($('designs-msg'), reply.message || 'Version restored.', 'ok'); }
        catch (err) { result($('designs-msg'), err.message, 'error'); }
      }))));
    }
  } catch (err) { host.replaceChildren(h('p', { class: 'result-msg', text: err.message })); }
}

function studioWebhookPayload(design, url) {
  const box = h('details', {}, h('summary', { text: 'Send scalar values with this link' })), form = h('div', { class: 'stack-form' });
  box.append(h('p', { class: 'hint', text: 'Use POST with {"values":{"/root/text":"Your value"}}. Only this design’s configured binding targets can change. GET never runs a webhook. Keep this capability link private.' }), form);
  const load = async () => {
    try {
      if (!automationData.designs) await loadAutomation('designs');
      const card = automationData.designs?.[design];
      if (!card) throw new Error('Load My designs first, or check that this design still exists.');
      const fields = (card.bindings || []).map(binding => {
        const include = h('input', { type: 'checkbox' }), scalar = studioScalarControl(studioBindingTargets(card).find(item => item.target === binding.target)?.value ?? '');
        form.append(h('fieldset', {}, h('legend', { text: binding.target }), h('label', { class: 'check' }, include, 'Send this field'), scalar.element));
        return [binding.target, include, scalar];
      });
      if (!fields.length) form.append(h('p', { class: 'hint', text: 'Add scalar bindings in Card studio to accept webhook values.' }));
      const body = () => ({ values: Object.fromEntries(fields.filter(([, include]) => include.checked).map(([target, , scalar]) => [target, scalar.read()])) });
      form.append(studioButton('Copy POST command', async () => { try { await copyText('curl -X POST -H ' + shellQuote('Content-Type: application/json') + ' --data ' + shellQuote(JSON.stringify(body())) + ' ' + shellQuote(url)); say('POST command copied.'); } catch (err) { say(err.message, 'error'); } }), studioButton('Send values to TV', async () => {
        try { await call('POST', new URL(url).pathname, { json: body(), private: true }); say('Webhook sent.'); } catch (err) { say(err.message, 'error'); }
      }));
    } catch (err) { form.replaceChildren(h('p', { class: 'hint', text: err.message }), studioButton('Try again', () => { form.replaceChildren(); load(); })); }
  };
  box.addEventListener('toggle', () => { if (box.open && !form.children.length) load(); });
  return box;
}

async function studioLoadRotations() {
  if (!$('rotations-list') || studioRole === 'guest') return;
  try {
    const { entries } = await call('GET', '/api/rotations', { private: true }), host = $('rotations-list'); host.replaceChildren();
    for (const [id, entry] of Object.entries(entries)) {
      const row = h('div', { class: 'rotation-row' }, h('strong', { text: entry.designs.join(' → ') }), h('p', { class: 'hint', text: `Every ${entry.interval_seconds} seconds · ${entry.enabled ? 'Enabled' : 'Disabled'}` }));
      row.append(studioButton(entry.enabled ? 'Pause rotation' : 'Enable rotation', async () => { try { await call('PUT', '/api/rotations/' + encodeURIComponent(id), { json: { ...entry, enabled: !entry.enabled } }); await studioLoadRotations(); } catch (err) { result($('rotations-msg'), err.message, 'error'); } }), studioButton('Edit rotation', () => { $('rotation-designs').value = entry.designs.join('\n'); $('rotation-interval').value = entry.interval_seconds; $('rotation-enabled').checked = entry.enabled; $('rotation-form').dataset.id = id; $('rotation-save').textContent = 'Save rotation changes'; }), studioButton('Delete rotation', () => askInPlace(row, 'Delete this rotation?', 'Delete', async () => { try { await call('DELETE', '/api/rotations/' + encodeURIComponent(id)); await studioLoadRotations(); } catch (err) { result($('rotations-msg'), err.message, 'error'); } })));
      host.append(row);
    }
    if (!Object.keys(entries).length) host.append(h('p', { class: 'hint', text: 'No rotations yet. Choose saved designs below.' }));
  } catch (err) { result($('rotations-msg'), err.message, 'error'); }
}

function studioApplyRole(role, actions = null) {
  studioRole = role;
  studioActions = [];
  try {
    if (role) sessionStorage.setItem('webos-foundry-role', role); else sessionStorage.removeItem('webos-foundry-role');
    if (actions) sessionStorage.setItem('webos-foundry-actions', JSON.stringify(actions));
    if (!role) sessionStorage.removeItem('webos-foundry-actions');
  } catch { /* Storage can be disabled. */ }
  document.body.dataset.role = role;
  for (const tab of document.querySelectorAll('[data-view]')) if (!['home', 'remote', 'settings'].includes(tab.dataset.view)) tab.hidden = role === 'guest';
  for (const button of document.querySelectorAll('[data-action]')) delete button.dataset.guestBlocked;
  if (role === 'guest') {
    studioStopEvents(); studioCancelLive(true); studioClearSnapshot(); stopLive();
    clearTimeout(S.jobTimer); S.jobTimer = null; S.job = null; S.reserved = false;
    if (!actions) { try { actions = JSON.parse(sessionStorage.getItem('webos-foundry-actions') || '[]'); } catch { actions = []; } }
    if (!Array.isArray(actions)) actions = [];
    studioActions = actions;
    for (const button of document.querySelectorAll('[data-action]')) if (!actions.includes(button.dataset.action)) { button.disabled = true; button.dataset.guestBlocked = 'true'; }
    showView('remote');
  }
  syncRemoteVolume();
}
async function studioLoadUsers() {
  if (!$('access-users') || studioRole === 'guest') return;
  try {
    const { users } = await call('GET', '/api/access/users', { private: true }), host = $('access-users'); host.replaceChildren();
    for (const [key, value] of Object.entries(users)) {
      const user = typeof value === 'object' ? value : { role: value }, name = user.name || key;
      const row = h('div', { class: 'account-row' }, h('strong', { text: name }), h('span', { text: ' · ' + user.role }));
      row.append(studioButton('Edit account', () => { $('access-name').value = name; $('access-role').value = user.role; $('access-pin').value = ''; for (const input of $('access-actions').querySelectorAll('input')) input.checked = (user.actions || []).includes(input.value); }), studioButton('Delete account', () => askInPlace(row, 'Delete ' + name + ' and revoke its sessions?', 'Delete', async () => { try { await call('DELETE', '/api/access/users/' + encodeURIComponent(name), { private: true }); await studioLoadUsers(); } catch (err) { result($('access-msg'), err.message, 'error'); } })));
      host.append(row);
    }
    if (!Object.keys(users).length) host.append(h('p', { class: 'hint', text: 'No PIN accounts. Your existing administrator token still works.' }));
    const { sessions } = await call('GET', '/api/access/sessions', { private: true });
    const sessionHost = $('access-sessions'); sessionHost.replaceChildren();
    for (const [key, session] of Object.entries(sessions)) {
      const id = session.id || key;
      sessionHost.append(h('div', { class: 'row' }, h('span', { text: `${session.name} · ${session.role} · expires ${new Date(session.expires * 1000).toLocaleString()}` }), studioButton('Revoke session', async () => { try { await call('DELETE', '/api/access/sessions/' + encodeURIComponent(id), { private: true }); await studioLoadUsers(); } catch (err) { result($('access-msg'), err.message, 'error'); } })));
    }
  } catch (err) { result($('access-msg'), 'Account administration: ' + err.message, 'error'); }
}

function studioEventsHealthy() { return !!studioEventController && Date.now() - studioEventAt < 45000; }
function studioStopEvents() {
  clearTimeout(studioEventTimer); studioEventTimer = null;
  const controller = studioEventController; studioEventController = null; controller?.abort(); studioEventAt = 0;
  if ($('event-status')) $('event-status').textContent = document.hidden ? 'Updates paused' : 'Polling updates';
}
async function studioStartEvents() {
  if (studioEventController || document.hidden || studioRole === 'guest' || !supports({ route: '/api/events' })) return;
  clearTimeout(studioEventTimer);
  const controller = new AbortController(); studioEventController = controller;
  $('event-status').textContent = 'Connecting updates…';
  let reader, idleTimer;
  const touch = () => { studioEventAt = Date.now(); clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), 45000); };
  try {
    const response = await fetch('/api/events', { headers: S.token ? { Authorization: 'Bearer ' + S.token } : {}, signal: controller.signal, cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Event stream unavailable (HTTP ' + response.status + ').');
    reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    touch(); $('event-status').textContent = 'Live updates';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      touch(); buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/gu, '\n');
      if (buffer.length > 262144) throw new Error('Event frame too large.');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const state = JSON.parse(data);
        studioEventBackoff = 1000;
        if (state.status) { S.status = state.status; S.statusError = null; renderStatus(); sync(); }
        if (state.jobs?.active) {
          const active = typeof state.jobs.active === 'object' ? state.jobs.active : state.jobs.jobs?.find(job => job.id === state.jobs.active);
          if (active) showJob(active);
        }
        if (state.overlay) $('event-status').textContent = state.overlay.visible ? 'Live updates · card shown' : 'Live updates';
      }
    }
    throw new Error('Event stream ended.');
  } catch (err) {
    if (!document.hidden && studioEventController === controller) $('event-status').textContent = 'Reconnecting · polling updates';
  } finally {
    clearTimeout(idleTimer); await reader?.cancel().catch(() => {});
    if (studioEventController === controller) {
      studioEventController = null; studioEventAt = 0;
      if (!document.hidden && studioRole !== 'guest') { studioEventTimer = setTimeout(studioStartEvents, studioEventBackoff); studioEventBackoff = Math.min(30000, studioEventBackoff * 2); }
    }
  }
}

function wireStudioExtras() {
  document.addEventListener('keydown', studioKeyboard);
  $('token-use-pin').addEventListener('click', () => { S.promptDismissed = true; $('token-dialog').close(); showView('settings'); $('login-name').focus(); });
  $('ov-undo').addEventListener('click', () => studioUndo(-1)); $('ov-redo').addEventListener('click', () => studioUndo(1));
  $('ov-safe-area').addEventListener('change', event => { $('ov-preview').classList.toggle('show-safe-area', event.target.checked); });
  $('ov-snapshot').addEventListener('click', studioCaptureSnapshot); $('ov-snapshot-clear').addEventListener('click', studioClearSnapshot);
  $('ov-live-edit').addEventListener('change', event => { studioCancelLive(); studioLiveSent = ''; if (event.target.checked) { result($('ov-live-msg'), 'Live editing sends your full draft after a short pause. It does not save designs.'); studioQueueLive(); } else result($('ov-live-msg'), 'Live editing off. The TV keeps its last card until you hide or replace it.'); });
  $('ov-theme-form').addEventListener('submit', event => { event.preventDefault(); studioSaveTheme(); });
  $('ov-themes-refresh').addEventListener('click', studioLoadThemes);
  $('rotation-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, id = form.dataset.id;
    const body = { designs: $('rotation-designs').value.split('\n').map(name => name.trim()).filter(Boolean), interval_seconds: Number($('rotation-interval').value), enabled: $('rotation-enabled').checked };
    if (!body.designs.length || body.designs.length > 20 || !Number.isInteger(body.interval_seconds) || !inRange(body.interval_seconds, 15, 86400)) return result($('rotations-msg'), 'Choose 1–20 design names and an interval of 15–86400 whole seconds.', 'error');
    try { await call(id ? 'PUT' : 'POST', '/api/rotations' + (id ? '/' + encodeURIComponent(id) : ''), { json: body }); form.reset(); delete form.dataset.id; $('rotation-save').textContent = 'Save rotation'; result($('rotations-msg'), 'Rotation saved.', 'ok'); await studioLoadRotations(); }
    catch (err) { result($('rotations-msg'), err.message, 'error'); }
  });
  $('rotation-new').addEventListener('click', () => { $('rotation-form').reset(); delete $('rotation-form').dataset.id; $('rotation-save').textContent = 'Save rotation'; });
  $('rotations-refresh').addEventListener('click', studioLoadRotations);
  $('webhook-target-type').addEventListener('change', event => {
    const design = event.target.value === 'design';
    $('webhook-target-label').textContent = design ? 'Design name' : 'Scene name';
    $('webhook-scene').setAttribute('list', design ? 'design-names' : 'automation-scenes');
    if (design && !automationData.designs) loadAutomation('designs');
  });
  $('access-login-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const response = await fetch('/api/access/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('login-name').value.trim(), pin: $('login-pin').value }) });
      const reply = await response.json(); $('login-pin').value = '';
      if (!response.ok) throw new Error(reply.error || 'Sign-in failed.');
      saveToken(reply.token, false); studioApplyRole(reply.role, reply.actions); studioStopEvents();
      $('token-dialog').close(); result($('access-login-msg'), 'Signed in as ' + reply.role + '. ' + (reply.warning || ''), 'ok');
      await loadAll(); studioStartEvents();
    } catch (err) { result($('access-login-msg'), err.message, 'error'); }
  });
  $('access-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('access-name').value.trim(), pin = $('access-pin').value, role = $('access-role').value;
    const body = { pin, role, actions: [...$('access-actions').querySelectorAll('input:checked')].map(input => input.value) };
    try { await call('PUT', '/api/access/users/' + encodeURIComponent(name), { json: body, private: true }); $('access-pin').value = ''; result($('access-msg'), 'Account saved. Existing sessions are revoked when credentials change.', 'ok'); await studioLoadUsers(); }
    catch (err) { result($('access-msg'), err.message, 'error'); }
  });
  $('access-refresh').addEventListener('click', studioLoadUsers);
  $('access-logout').addEventListener('click', async () => {
    try { await call('POST', '/api/access/logout', { private: true }); } catch (err) { if (err.status !== 401) return result($('access-login-msg'), err.message, 'error'); }
    studioStopEvents(); saveToken(''); studioApplyRole(''); result($('access-login-msg'), 'Signed out.');
  });
  for (const [action, label] of Object.entries(SCENE_REMOTE)) $('access-actions').append(h('label', { class: 'check' }, h('input', { type: 'checkbox', value: action, checked: ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'volume_up', 'volume_down', 'volume', 'mute', 'unmute'].includes(action) }), label));
  try { if (S.token) studioApplyRole(sessionStorage.getItem('webos-foundry-role') || ''); } catch { /* Storage can be disabled. */ }
  studioSyncHistory(); renderStudioExtras();
}
