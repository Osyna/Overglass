// Run: node web/check-automate.mjs (no server, browser or TV required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = '';
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    this.classList = {
      contains: name => (this.className || '').split(/\s+/).includes(name),
      toggle: (name, enabled) => {
        const names = new Set((this.className || '').split(/\s+/).filter(Boolean));
        if (enabled ?? !names.has(name)) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
    };
  }
  setAttribute(name, value) {
    this[name === 'class' ? 'className' : name] = name === 'disabled' || name === 'selected' ? true : value;
    if (name === 'id') elements.set(value, this);
  }
  getAttribute(name) { return this[name === 'class' ? 'className' : name] ?? null; }
  removeAttribute(name) { delete this[name]; }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      if (node instanceof Element) node.parent = this;
    }
    if (this.tag === 'select') this.value = (this.children.find(child => child.selected) || this.children[0])?.value;
  }
  prepend(...nodes) {
    this.children.unshift(...nodes);
    for (const node of nodes) if (node instanceof Element) node.parent = this;
  }
  replaceChildren(...nodes) {
    assert(nodes.every(node => !Array.isArray(node)), 'DOM children must be spread, not passed as an array');
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  querySelectorAll(selector) {
    return this.children.filter(child => child instanceof Element).flatMap(child =>
      [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const simple = part.trim();
      if (simple.startsWith('.')) return this.classList.contains(simple.slice(1));
      if (simple.startsWith('#')) return this.id === simple.slice(1);
      const attribute = simple.match(/^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (attribute) return this.getAttribute(attribute[1]) !== null && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
      return this.tag === simple;
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  focus() { this.focused = true; }
  select() { this.selectedText = true; }
  scrollIntoView() { this.scrolledIntoView = true; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  insertBefore(node, before) {
    const at = this.children.indexOf(before);
    this.children.splice(at < 0 ? this.children.length : at, 0, node); node.parent = this;
  }
  before(node) { this.parent.insertBefore(node, this); }
  get parentNode() { return this.parent; }
  get parentElement() { return this.parent; }
  get firstElementChild() { return this.children.find(child => child instanceof Element); }
}
const elements = new Map();
const context = vm.createContext({
  assert, TextEncoder, URL, setTimeout() {}, clearTimeout() {}, location: { origin: 'http://localhost:8765' },
  navigator: {}, window: { addEventListener() {} },
  document: {
    body: new Element('body'), addEventListener() {},
    querySelectorAll(selector) {
      if (!selector.startsWith('#apps-list') && !selector.startsWith('#bundled-apps')) return [];
      return selector.split(',').flatMap(part => { const [id, tag] = part.trim().split(/\s+/); return elements.get(id.slice(1))?.querySelectorAll(tag) || []; });
    },
    createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag),
    getElementById: id => {
      if (id === 'scene-builder' && !elements.has(id)) return null;
      if (!elements.has(id)) { const el = new Element('div'); el.id = id; elements.set(id, el); }
      return elements.get(id);
    },
  },
});
vm.runInContext(fs.readFileSync(new URL('./studio.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('./apps.js', import.meta.url), 'utf8'), context);
await vm.runInContext(`(async () => {
  automationData.scenes = { '<scene>': { steps: [{ type: 'wait', seconds: 0 }] } };
  renderAutomation('scenes');
  assert.equal($('automation-scenes').children.length, 1);
  assert.equal($('automation-scenes').children[0].value, '<scene>');
  assert.equal($('scenes-list').children[0].children[0].children[0].children[0].textContent, '<scene>');
  automationData.scenes = {};
  renderAutomation('scenes');
  assert.equal($('automation-scenes').children.length, 0);
  assert.match($('scenes-list').children[0].textContent, /No scenes/);

  const realChangeAutomation = changeAutomation;
  const realLoadAutomation = loadAutomation;
  const requests = [];
  changeAutomation = async (...args) => { requests.push(args); return {}; };
  loadAutomation = async () => {};
  const entry = { id: 'saved-id', scene: 'movie-night', time: '20:15', days: ['mon', 'fri'], enabled: true };
  const row = automationRow('schedule', entry.id, entry);
  const toggle = row.children[1].children[0];
  assert.equal(toggle.textContent, 'Disable');
  await toggle.listeners.click();
  const [kind, , method, path, body] = requests.pop();
  assert.equal(kind, 'schedule');
  assert.equal(method, 'PUT');
  assert.equal(path, '/api/schedule/saved-id');
  assert.equal(JSON.stringify(body), JSON.stringify({ scene: entry.scene, time: entry.time, days: entry.days, enabled: false }));
  assert.equal(entry.enabled, true, 'do not mutate cached entries before the server accepts them');
  const disabled = automationRow('schedule', entry.id, { ...entry, enabled: false });
  assert.equal(disabled.children[1].children[0].textContent, 'Enable');
  await disabled.children[1].children[0].listeners.click();
  assert.equal(requests.pop()[4].enabled, true);

  const webhook = automationRow('webhooks', 'private-token', { scene: 'movie-night', label: 'Shortcut' });
  assert.equal(webhook.children[1].value, location.origin + '/webhook/private-token');
  assert.equal(webhook.children[1].readonly, '');
  assert.equal(webhook.children[2].children[0].children[1].textContent, 'Copy link');

  // Synthetic catalog: exercises extensibility without depending on any shipped connector.
  const addon = { id: 'synthetic/id', name: '<Synthetic extension>', description: 'Synthetic catalog fixture', category: 'tests',
    default_interval_seconds: 90, params_schema: [
      { key: 'choice', label: 'Choose a value', type: 'select', choices: [{ value: 'a', label: 'Choice A' }, { value: 'b', label: 'Choice B' }], default: 'a' },
      { key: 'caption', label: 'Caption', type: 'text', default: 'Default caption' },
    ] };
  const walk = el => [el, ...(el.children || []).filter(child => typeof child === 'object').flatMap(walk)];
  const button = (el, text) => walk(el).find(child => child.tag === 'button' && child.textContent === text);
  automationData.addons = { catalog: [addon], installed: {} };
  renderAutomation('addons');
  const card = $('addons-list').children[0].children[0];
  assert.equal(card.children[0].children[0].textContent, addon.name, 'catalog names stay plain text');
  assert.match(card.children[0].children[2].textContent, /Not installed/);
  assert(button(card, 'Install'));
  assert.equal(button(card, 'Uninstall'), undefined);
  assert.equal(button(card, 'Enable'), undefined);
  assert.equal(button(card, 'Disable'), undefined);
  const form = card.querySelector('form');
  const select = form.querySelector('select');
  assert.equal(select.children[0].textContent, 'Choice A');
  assert.equal(select.value, 'a');
  const inputs = form.querySelectorAll('input');
  assert.equal(inputs[0].value, 'Default caption');
  assert.equal(inputs[1].min, 15);
  assert.equal(inputs[1].max, 3600);
  assert.equal(inputs[1].value, 90);
  for (const control of form.querySelectorAll('input, select')) assert.ok(control.parent.tag === 'label' || control['aria-label'], 'every extension control is labelled');
  const selects = form.querySelectorAll('select');
  assert.equal(selects[1].value, 'top-right', 'placement defaults to the TV default position');
  assert.equal(selects[2].value, 'm');
  assert.equal(selects[1].children.length, 9, 'all nine positions including edge bars and panels');
  const colours = inputs.filter(input => input.type === 'color');
  assert.equal(colours.length, 2, 'compact look: accent and background');
  assert.equal(inputs.filter(input => input.type === 'range').length, 1, 'compact look: opacity');
  select.value = 'b'; inputs[0].value = 'Current caption'; inputs[1].value = '30';
  await button(card, 'Preview on TV').listeners.click();
  let request = requests.pop();
  assert.equal(request[2], 'POST');
  assert.equal(request[3], '/api/addons/synthetic%2Fid/preview');
  assert.equal(JSON.stringify(request[4]), JSON.stringify({ params: { choice: 'b', caption: 'Current caption' } }));
  assert.equal(Object.keys(automationData.addons.installed).length, 0, 'preview must not install');
  await form.listeners.submit({ preventDefault() {} });
  request = requests.pop();
  assert.equal(request[0], 'addons');
  assert.equal(request[2], 'PUT');
  assert.equal(request[3], '/api/addons/synthetic%2Fid');
  assert.equal(JSON.stringify(request[4]), JSON.stringify({ params: { choice: 'b', caption: 'Current caption' }, interval_seconds: 30, enabled: true,
    position: 'top-right', size: 'm' }));  // an untouched Look sends no theme at all
  selects[1].value = 'right'; selects[2].value = 's';
  colours[0].value = '#e8c35a'; colours[0].listeners.input();
  const opacity = inputs.find(input => input.type === 'range');
  opacity.value = '0.8'; opacity.listeners.input();
  await form.listeners.submit({ preventDefault() {} });
  request = requests.pop();
  assert.equal(JSON.stringify(request[4]), JSON.stringify({ params: { choice: 'b', caption: 'Current caption' }, interval_seconds: 30, enabled: true,
    position: 'right', size: 's', theme: { accent: '#e8c35a', opacity: 0.8 } }));

  const installed = { params: { choice: 'b', caption: 'Saved caption' }, interval_seconds: 120, enabled: true, position: 'bottom-left', size: 's',
    theme: { accent: '#ff8800', opacity: 0.6 } };
  automationData.addons.installed[addon.id] = installed;
  renderAutomation('addons');
  const enabledCard = $('addons-list').children[0].children[0];
  assert.match(enabledCard.children[0].children[2].textContent, /Installed · Enabled/);
  assert(button(enabledCard, 'Update'));
  assert.equal(enabledCard.querySelector('select').value, 'b');
  assert.equal(enabledCard.querySelectorAll('input')[1].value, 120);
  assert.equal(enabledCard.querySelectorAll('select')[1].value, 'bottom-left', 'saved position is shown');
  assert.equal(enabledCard.querySelectorAll('select')[2].value, 's', 'saved size is shown');
  assert.equal(enabledCard.querySelectorAll('input').find(input => input.type === 'color').value, '#ff8800', 'saved accent is shown');
  assert.equal(enabledCard.querySelectorAll('input').find(input => input.type === 'range').value, 0.6, 'saved opacity is shown');
  assert.equal(enabledCard.querySelector('details').open, '', 'a saved look opens the Look group');
  await button(enabledCard, 'Disable').listeners.click();
  request = requests.pop();
  assert.equal(request[2], 'PUT');
  assert.equal(request[3], '/api/addons/synthetic%2Fid');
  assert.equal(JSON.stringify(request[4]), JSON.stringify({ ...installed, enabled: false }));
  assert.equal(installed.enabled, true, 'do not mutate cached extension settings before server confirmation');
  const disabledCard = addonCard(addon, { ...installed, enabled: false });
  assert.match(disabledCard.children[0].children[2].textContent, /Installed · Disabled/);
  await disabledCard.querySelector('form').listeners.submit({ preventDefault() {} });
  assert.equal(requests.pop()[4].enabled, false, 'editing a paused extension does not silently resume automatic display');
  await button(disabledCard, 'Enable').listeners.click();
  assert.equal(requests.pop()[4].enabled, true);
  button(enabledCard, 'Uninstall').listeners.click();
  assert.equal(requests.length, 0, 'uninstall first asks in place');
  assert.match(enabledCard.querySelector('.app-confirm').children[0].textContent, /Uninstall/);
  assert.equal(button(enabledCard, 'Keep it').focused, true);
  await enabledCard.querySelector('.app-confirm').children[2].listeners.click();
  request = requests.pop();
  assert.equal(request[2], 'DELETE');
  assert.equal(request[3], '/api/addons/synthetic%2Fid');
  automationData.addons = { catalog: [], installed: {} };
  renderAddons();
  assert.match($('addons-list').children[0].textContent, /No extensions/);

  // Saved designs: real thumbnails, safe names, load/show/delete/save and rename.
  automationData.designs = {};
  renderAutomation('designs');
  assert.match($('designs-list').children[0].textContent, /No saved designs/);
  assert.equal($('design-names').children.length, 0);
  const dot = { type: 'dot' };
  const hud = { seconds: 0, theme: { accent: '#e8c35a' }, regions: [{ position: 'top', size: 'full', root: dot }, { position: 'right', size: 's', root: { type: 'stack', children: [dot, dot] } }] };
  automationData.designs = { '<match day>': hud, toast: { position: 'top-right', root: dot } };
  renderAutomation('designs');
  assert.equal($('design-names').children.length, 2);
  assert.equal($('design-names').children[0].value, '<match day>');
  assert.ok($('designs-list').querySelector('.design-grid'));
  const tiles = $('designs-list').querySelectorAll('.design-tile');
  assert.equal(tiles.length, 2);
  const designRow = tiles[0];
  assert.ok(walk(designRow).some(el => el.textContent === '<match day>'), 'design names stay plain text');
  assert.ok(walk(designRow).some(el => el.textContent === '2 regions · Top bar, Right panel · 4 widgets · stays until hidden'));
  assert.ok(walk(tiles[1]).some(el => el.textContent === 'Single card · Top right · 1 widget · 8 s'));
  const thumbnail = walk(designRow).find(el => el.classList.contains('tv-stage') && el.classList.contains('tv-thumb'));
  assert.ok(thumbnail, 'saved designs show their actual TV layout');
  assert.equal(thumbnail.querySelector('.tv-screen').children.length, 2, 'thumbnail preserves both regions');
  assert(button(designRow, 'Load'));
  assert(button(designRow, 'Show on TV'));
  assert(button(designRow, 'Rename'));
  const deleteButton = walk(designRow).find(el => el.tag === 'button' && el['aria-label'] === 'Delete <match day>');
  assert(deleteButton);
  await button(designRow, 'Show on TV').listeners.click();
  request = requests.pop();
  assert.equal(request[0], 'designs');
  assert.equal(request[2], 'POST');
  assert.equal(request[3], '/api/designs/%3Cmatch%20day%3E/show');
  assert.equal(request[4], undefined);
  // Load replaces the studio draft; a dirty draft asks first.
  const studioCalls = [];
  setOverlayCard = card => studioCalls.push(card);
  overlayLoaded = JSON.stringify(overlayBody());
  button(designRow, 'Load').listeners.click();
  assert.equal(studioCalls.length, 1, 'a clean draft loads at once');
  assert.equal(JSON.stringify(studioCalls[0]), JSON.stringify(hud));
  assert.notEqual(studioCalls[0], hud, 'the studio gets a copy, not the cached entry');
  assert.equal($('design-name').value, '<match day>');
  overlayCard.seconds = 42;
  button(designRow, 'Load').listeners.click();
  assert.equal(studioCalls.length, 1, 'a dirty draft asks first');
  const ask = designRow.querySelector('.app-confirm');
  assert.match(ask.children[0].textContent, /Replace your draft/);
  assert.equal(button(ask, 'Keep it').focused, true);
  button(ask, 'Keep it').listeners.click();
  assert.equal(designRow.querySelector('.app-confirm'), undefined);
  assert.equal(studioCalls.length, 1);
  button(designRow, 'Load').listeners.click();
  button(designRow.querySelector('.app-confirm'), 'Replace').listeners.click();
  assert.equal(studioCalls.length, 2);
  deleteButton.listeners.click();
  assert.equal(requests.length, 0, 'delete first asks in place');
  assert.match(designRow.querySelector('.app-confirm').children[0].textContent, /Delete <match day>\\?.*Scenes/);
  await designRow.querySelector('.app-confirm').children[2].listeners.click();
  request = requests.pop();
  assert.equal(request[2], 'DELETE');
  assert.equal(request[3], '/api/designs/%3Cmatch%20day%3E');
  // Save: overwriting an existing name asks first; the body is the studio draft.
  overlayCard = { position: 'center', seconds: 5, theme: {}, root: dot };
  overlayError = ''; overlayJsonDirty = false;
  $('design-name').value = 'toast';
  await saveDesign();
  assert.equal(requests.length, 0, 'saving over an existing design asks first');
  assert.match($('design-form').querySelector('.app-confirm').children[0].textContent, /Replace the saved design toast/);
  await button($('design-form').querySelector('.app-confirm'), 'Replace').listeners.click();
  request = requests.pop();
  assert.equal(request[2], 'PUT');
  assert.equal(request[3], '/api/designs/toast');
  assert.equal(JSON.stringify(request[4]), JSON.stringify({ position: 'center', seconds: 5, root: dot }), 'the empty Look object is left out');
  $('design-name').value = 'fresh name';
  await saveDesign();
  assert.equal(requests.pop()[3], '/api/designs/fresh%20name');
  $('design-name').value = '  ';
  await saveDesign();
  assert.equal(requests.length, 0);
  assert.equal($('design-save-msg').dataset.tone, 'error');
  overlayJsonDirty = true;
  $('design-name').value = 'x';
  await saveDesign();
  assert.equal(requests.length, 0, 'unapplied JSON blocks saving');
  overlayJsonDirty = false;

  // Confirmed rename is one atomic request and preserves server-owned revision history.
  const renameRow = automationRow('designs', '<match day>', hud);
  const reviewRename = async (row, nextName) => {
    const form = row.querySelector('.design-rename');
    assert.ok(form, 'rename is an inline form');
    const nameInput = form.querySelector('input');
    assert.equal(nameInput['aria-label'], 'New name');
    assert(button(form, 'Review rename'));
    nameInput.value = nextName;
    await form.listeners.submit({ preventDefault() {} });
    return row.querySelector('.app-confirm');
  };
  button(renameRow, 'Rename').listeners.click();
  assert.equal(requests.length, 0);
  let renameAsk = await reviewRename(renameRow, 'evening / TV');
  assert.ok(renameAsk);
  assert.match(renameAsk.children[0].textContent, /Rename/);
  assert.equal(button(renameAsk, 'Keep it').focused, true);
  assert.equal(requests.length, 0, 'review never mutates the library before confirmation');
  button(renameAsk, 'Keep it').listeners.click();
  assert.equal(requests.length, 0, 'cancelled rename keeps the old design');
  renameAsk = await reviewRename(renameRow, 'evening / TV');
  await button(renameAsk, 'Rename').listeners.click();
  assert.equal(requests.length, 1);
  const renameRequest = requests.shift();
  assert.equal(renameRequest[2], 'POST');
  assert.equal(renameRequest[3], '/api/designs/%3Cmatch%20day%3E/rename');
  assert.equal(JSON.stringify(renameRequest[4]), JSON.stringify({ name: 'evening / TV' }));
  assert.equal(JSON.stringify(automationData.designs['<match day>']), JSON.stringify(hud), 'cached design is not changed optimistically');
  const successfulMutation = changeAutomation;
  changeAutomation = async (...args) => { requests.push(args); return undefined; };
  const failedRenameRow = h('li', { class: 'design-tile' });
  renameDesign('<match day>', hud, failedRenameRow);
  const failedRenameAsk = await reviewRename(failedRenameRow, 'Cannot save');
  await button(failedRenameAsk, 'Rename').listeners.click();
  assert.equal(requests.length, 1, 'a failed rename never issues a destructive delete');
  assert.equal(requests.pop()[2], 'POST');
  changeAutomation = successfulMutation;

  // Guided scenes produce the same API envelope as the advanced JSON editor.
  const guidedSteps = [
    { type: 'remote', action: 'home' },
    { type: 'setting', category: 'picture', key: 'brightness', value: 50, context: {} },
    { type: 'overlay', design: 'Movie' },
    { type: 'overlay', card: { root: { type: 'text', text: 'Hi' } } },
    { type: 'wait', seconds: 1.5 },
  ];
  const guidedScene = sceneFromSteps(guidedSteps);
  assert.equal(JSON.stringify(guidedScene), JSON.stringify({ steps: guidedSteps }));
  assert.notEqual(guidedScene.steps, guidedSteps);
  assert.notEqual(guidedScene.steps[1].context, guidedSteps[1].context, 'scene output does not share editable nested values');
  for (const type of ['remote', 'setting', 'overlay', 'wait']) {
    const step = newSceneStep(type);
    assert.equal(step.type, type);
  }
  for (const seconds of [0, 10]) assert.equal(sceneFromSteps([{ type: 'wait', seconds }]).steps[0].seconds, seconds);
  for (const value of [0, 40, 100]) assert.equal(sceneFromSteps([{ type: 'remote', action: 'volume', value }]).steps[0].value, value);
  for (const value of [-1, 101, 20.5, '20', true, null, undefined]) assert.throws(() => sceneFromSteps([{ type: 'remote', action: 'volume', value }]));
  assert.equal(sceneFromSteps(Array.from({ length: 20 }, () => ({ type: 'wait', seconds: 0 }))).steps.length, 20);
  for (const steps of [[], Array.from({ length: 21 }, () => ({ type: 'wait', seconds: 0 })), null, {},
    [{ type: 'unknown' }], [{ type: 'remote', action: '' }], [{ type: 'setting', category: '', key: 'brightness', value: 50 }],
    [{ type: 'setting', category: 'picture', key: '', value: 50 }], [{ type: 'overlay', design: '' }],
    [{ type: 'overlay', card: { root: { type: 'text' } } }],
    ...[-0.1, 10.1, '1', NaN, true].map(seconds => [{ type: 'wait', seconds }])]) {
    assert.throws(() => sceneFromSteps(steps), JSON.stringify(steps));
  }
  const sceneDetails = h('details', { open: true }, h('label', {}, $('scene-json')));
  $('scene-form').append(sceneDetails);
  sceneSteps = clone(guidedSteps);
  syncSceneJson();
  renderSceneBuilder();
  assert.equal(sceneDetails.open, false, 'guided controls start with advanced code collapsed');
  assert.ok($('scene-builder'));
  assert.equal($('scene-builder').parent, $('scene-form'), 'builder is mounted beside, not inside, advanced code');
  assert.equal($('scene-builder').querySelectorAll('.scene-step').length, 5);
  const lastStep = $('scene-builder').querySelectorAll('.scene-step')[4];
  const waitInput = lastStep.querySelector('input');
  waitInput.value = '2.5'; waitInput.listeners.input();
  assert.equal(JSON.parse($('scene-json').value).steps[4].seconds, 2.5, 'guided edits write numeric seconds to the request JSON');
  wireAutomation();
  $('scene-name').value = 'Movie / night';
  await $('scene-form').listeners.submit({ preventDefault() {} });
  request = requests.pop();
  assert.equal(request[0], 'scenes');
  assert.equal(request[2], 'PUT');
  assert.equal(request[3], '/api/scenes/Movie%20%2F%20night');
  assert.equal(JSON.stringify(request[4]), JSON.stringify({ steps: [...guidedSteps.slice(0, 4), { type: 'wait', seconds: 2.5 }] }));
  $('scene-json').value = JSON.stringify({ steps: [{ type: 'remote', action: 'mute' }] });
  await $('scene-form').listeners.submit({ preventDefault() {} });
  assert.equal(JSON.stringify(requests.pop()[4]), JSON.stringify({ steps: [{ type: 'remote', action: 'mute' }] }), 'advanced edits remain authoritative when saved');
  $('scene-json').value = '{"steps":';
  await $('scene-form').listeners.submit({ preventDefault() {} });
  assert.equal(requests.length, 0, 'invalid scene JSON never reaches the API');
  assert.equal($('scenes-msg').dataset.tone, 'error');

  // Exercise the shared request guard with real addon loading and mutations.
  changeAutomation = realChangeAutomation;
  loadAutomation = realLoadAutomation;
  const realSupports = supports;
  supports = () => true;
  result = (el, text, tone) => { el.textContent = text; el.dataset.tone = tone; };
  const panel = h('section', { class: 'panel' }, $('addons-list'), $('addons-refresh'));
  let finish;
  let calls = 0;
  call = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const loading = loadAutomation('addons');
  assert.equal($('addons-refresh').disabled, true);
  assert.equal($('addons-list')['aria-busy'], 'true');
  await loadAutomation('addons');
  assert.equal(calls, 1, 'loading cannot submit twice');
  finish({ catalog: [addon], installed: { [addon.id]: installed } });
  await loading;
  assert.equal($('addons-refresh').disabled, false);
  assert.equal($('addons-list')['aria-busy'], 'false');
  const loadedCard = $('addons-list').children[0].children[0];
  const disableButton = button(loadedCard, 'Disable');
  const changing = changeAutomation('addons', disableButton, 'PUT', '/api/addons/synthetic%2Fid', { ...installed, enabled: false });
  assert.equal(loadedCard.querySelector('select').disabled, true, 'selects lock while saving');
  assert.equal(disableButton.dataset.state, 'loading');
  await changeAutomation('addons', disableButton, 'PUT', '/api/addons/synthetic%2Fid', {});
  assert.equal(calls, 2, 'saving cannot submit twice');
  assert.equal(installed.enabled, true);
  finish({ message: 'Saved' });
  await changing;
  assert.equal(loadedCard.querySelector('select').disabled, undefined);
  assert.equal(disableButton.dataset.state, undefined);
  call = async () => { throw new Error('Preview needs a paired TV'); };
  assert.equal(await changeAutomation('addons', disableButton, 'POST', '/api/addons/synthetic%2Fid/preview', {}), undefined);
  assert.equal($('addons-msg').dataset.tone, 'error');
  assert.match($('addons-msg').textContent, /paired TV/);
  assert.equal(automationBusy.has('addons'), false);

  // Included apps install from their bundled ID, report readback errors, and share the app-operation guard.
  const included = { id: 'dev.webosfoundry.overlay', title: '<Overlay renderer>', description: 'Draw designs over the picture.', version: '1.0.1', installed: false, available: true };
  let bundledInstalled = false, installError = '', completeInstall, bundlePosts = 0, bundleGets = 0;
  S.api = null; S.status = { power: 'on' }; S.statusError = null; S.paired = true; S.reserved = false; studioRole = ''; S.view = 'apps';
  supports = realSupports;
  call = async (method, path) => {
    if (method === 'GET' && path === '/api/apps/bundled') { bundleGets++; return [{ ...included, installed: bundledInstalled }]; }
    if (method === 'GET' && path === '/api/apps') return [...(bundledInstalled ? [{ ...included, removable: true }] : []), { id: 'org.example.player', title: 'Player', removable: true }];
    if (method === 'POST') {
      bundlePosts++;
      if (completeInstall) await new Promise(resolve => { completeInstall = resolve; });
      if (installError) throw new Error(installError);
      bundledInstalled = true; return { id: included.id, installed: true, message: 'Installed and verified' };
    }
    if (method === 'DELETE') { bundledInstalled = false; return { message: 'Removed' }; }
    throw new Error('Unexpected request');
  };
  await loadApps();
  assert.equal($('apps-list').querySelectorAll('li').length, 1);
  const installButton = $('bundled-apps').querySelector('button');
  completeInstall = true; const installing = installButton.listeners.click(); await Promise.resolve();
  assert.equal(installButton.disabled, true); assert.equal($('app-url-install').disabled, true);
  await installBundledApp(A.bundled[0], installButton); assert.equal(bundlePosts, 1, 'double clicks do not start another install');
  completeInstall(); await installing; completeInstall = null;
  assert.equal(A.bundled[0].installed, true); assert.equal($('bundled-result').dataset.tone, 'ok');
  assert.equal($('apps-list').querySelectorAll('li').length, 1, 'the installed included app appears only in its own section');
  let repair = $('bundled-apps').querySelector('button'); assert.equal(repair.disabled, false);
  installError = 'Installation readback failed'; await repair.listeners.click();
  assert.equal($('bundled-result').dataset.tone, 'error'); assert.equal(A.busy, false); assert.match($('bundled-result').textContent, /not confirmed/);
  A.bundled[0].available = false; renderBundledApps(); repair = $('bundled-apps').querySelector('button');
  assert.equal(repair.disabled, true); await installBundledApp(A.bundled[0], repair); assert.equal(bundlePosts, 2);
  A.bundled[0].available = true;
  for (const blocked of ['reservation', 'standby', 'guest']) {
    S.reserved = blocked === 'reservation'; S.status.power = blocked === 'standby' ? 'off' : 'on'; studioRole = blocked === 'guest' ? 'guest' : '';
    syncApps(); await installBundledApp(A.bundled[0], repair); assert.equal(bundlePosts, 2);
  }
  S.reserved = false; S.status.power = 'on'; studioRole = ''; renderBundledApps();
  const bundledRow = $('bundled-apps').querySelector('li'), uninstall = $('bundled-apps').querySelectorAll('button')[1];
  uninstall.listeners.click(); const confirmation = bundledRow.querySelector('.app-confirm');
  await button(confirmation, 'Remove').listeners.click();
  assert.equal(A.bundled[0].installed, false, 'removal refreshes the included-app status');
  S.api = { routes: [{ path: '/api/apps', group: 'Apps' }] };
  bundledInstalled = true;
  const beforeBundleGet = bundleGets; await loadApps();
  assert.equal($('panel-bundled').hidden, true); assert.equal(bundleGets, beforeBundleGet);
  assert.equal($('apps-list').querySelectorAll('li').length, 2, 'older servers retain the normal installed-app list');
})()`, context);
console.log('check-automate: ok (guided scene output, safe text, schedule toggles, private copy-only URLs, extension catalog/forms/install/preview/toggles/uninstall with placement and Look, saved-design thumbnails/load/show/delete/save/confirmed rename, busy guards and errors)');
