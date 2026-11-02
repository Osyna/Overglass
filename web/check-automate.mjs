// Run: node web/check-automate.mjs (no server, browser or TV required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; }
  setAttribute(name, value) { this[name] = name === 'disabled' || name === 'selected' ? true : value; }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      if (node instanceof Element) node.parent = this;
    }
    if (this.tag === 'select') this.value = (this.children.find(child => child.selected) || this.children[0])?.value;
  }
  replaceChildren(...nodes) {
    assert(nodes.every(node => !Array.isArray(node)), 'DOM children must be spread, not passed as an array');
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  querySelectorAll(selector) {
    const matches = el => selector.split(',').some(part => part.trim().startsWith('.')
      ? el.className?.split(' ').includes(part.trim().slice(1)) : el.tag === part.trim());
    return this.children.filter(child => child instanceof Element).flatMap(child =>
      [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  closest() { return this.parent; }
  focus() { this.focused = true; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}
const elements = new Map();
const context = vm.createContext({
  assert, location: { origin: 'http://localhost:8765' },
  document: {
    addEventListener() {},
    createElement: tag => new Element(tag), createElementNS: () => new Element(),
    getElementById: id => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
  },
});
vm.runInContext(fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8'), context);
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

  // Saved designs (Show view): list, load, show, delete.
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
  const designRow = $('designs-list').children[0].children[0];
  assert.equal(designRow.children[0].children[0].textContent, '<match day>', 'design names stay plain text');
  assert.equal(designRow.children[0].children[1].textContent, '2 regions · Top bar, Right panel · 4 widgets · stays until hidden');
  assert.equal($('designs-list').children[0].children[1].children[0].children[1].textContent, 'Single card · Top right · 1 widget · 8 s');
  assert(button(designRow, 'Load'));
  assert(button(designRow, 'Show on TV'));
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
  assert.equal($('designs-msg').dataset.tone, 'error');
  overlayJsonDirty = true;
  $('design-name').value = 'x';
  await saveDesign();
  assert.equal(requests.length, 0, 'unapplied JSON blocks saving');
  overlayJsonDirty = false;

  // Exercise the shared request guard with real addon loading and mutations.
  changeAutomation = realChangeAutomation;
  loadAutomation = realLoadAutomation;
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
})()`, context);
console.log('check-automate: ok (scene suggestions, empty state, safe text, schedule toggles, private copy-only URLs, extension catalog/forms/install/preview/toggles/uninstall with placement and look, saved designs list/load/show/delete/save, busy guards and errors)');
