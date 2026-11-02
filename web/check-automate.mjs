// Run: node web/check-automate.mjs (no server, browser or TV required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor() { this.children = []; this.dataset = {}; this.listeners = {}; }
  setAttribute(name, value) { this[name] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) {
    assert(nodes.every(node => !Array.isArray(node)), 'DOM children must be spread, not passed as an array');
    this.children = nodes;
  }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}
const elements = new Map();
const context = vm.createContext({
  assert, location: { origin: 'http://localhost:8765' },
  document: {
    addEventListener() {},
    createElement: () => new Element(), createElementNS: () => new Element(),
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
})()`, context);
console.log('check-automate: ok (scene suggestions, empty state, safe text, schedule toggles, private copy-only URLs)');
