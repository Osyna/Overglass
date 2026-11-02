// Run: node web/check-overlay.mjs (no server, browser or TV required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {};
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
  }
  setAttribute(name, value) { this[name] = ['disabled', 'selected'].includes(name) ? true : value; }
  removeAttribute(name) { delete this[name]; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); if (node instanceof Element) node.parent = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() { this.focused = true; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  querySelectorAll() { return []; }
}
const elements = new Map();
const context = vm.createContext({
  assert, TextEncoder, URL,
  document: {
    addEventListener() {}, hidden: false, createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag),
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); },
  },
});
vm.runInContext(fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8'), context);
vm.runInContext(`
  const walk = el => [el, ...(el.children || []).filter(child => typeof child === 'object').flatMap(walk)];
  const buttons = el => walk(el).filter(child => child.tag === 'button');
  const button = (el, text) => buttons(el).find(child => child.textContent === text);
  const inputs = el => walk(el).filter(child => ['input', 'select', 'textarea'].includes(child.tag));

  // --- every widget type: the blank node validates, previews, and renders builder controls ---
  assert.equal(Object.keys(OVERLAY_FIELDS).length, 18);
  assert.deepEqual(Object.keys(OVERLAY_FIELDS), ['stack', 'row', 'text', 'image', 'badge', 'dot', 'progress', 'countdown', 'list',
    'divider', 'compare', 'sparkline', 'section', 'event', 'stat', 'status', 'meta', 'clock']);
  assert.deepEqual(OVERLAY_TONES, ['info', 'success', 'warning', 'alert', 'accent']);
  assert.equal(Object.keys(OVERLAY_ICONS).length, 16);
  for (const type of Object.keys(OVERLAY_FIELDS)) {
    const node = newOverlayNode(type);
    assert.equal(checkOverlayTree(node), node);
    assert.equal(previewOverlayNode(node).className, 'w-' + type);
    assert.ok(OVERLAY_NAMES[type], type + ' has a plain-word name');
  }
  const nested = { type: 'stack', gap: 48, align: 'end', children: [
    { type: 'row', children: [{ type: 'badge', text: 'Ready', tone: 'accent' }, { type: 'dot', tone: 'accent' }] },
    { type: 'progress', value: 1, label: 'Done', tone: 'accent' },
    { type: 'text', text: '<script>not HTML</script>', size: 'xl', weight: 'strong', color: 'accent' },
    { type: 'list', items: ['One', 'Two'], style: 'number' }, { type: 'divider' },
  ] };
  assert.equal(checkOverlayTree(nested), nested);
  assert.equal(overlayNodeCount(nested), 8);

  // --- existing widgets, new fields ---
  for (const shape of ['square', 'circle']) for (const size of ['s', 'm', 'l']) checkOverlayTree({ type: 'image', src: 'https://example.com/image.png', shape, size });
  assert.throws(() => checkOverlayTree({ type: 'image', src: 'https://example.com/image.png', size: 'xl' }));
  const segment = { label: 'x'.repeat(24), value: 'x'.repeat(16), fraction: 0, tone: 'success' };
  for (const length of [2, 3, 4]) checkOverlayTree({ type: 'compare', segments: Array.from({ length }, () => ({ ...segment, fraction: 1 })) });
  for (const length of [3, 24]) checkOverlayTree({ type: 'sparkline', points: Array.from({ length }, (_, i) => i % 2 ? -1 : 1), tone: 'warning' });
  checkOverlayTree({ type: 'sparkline', points: [0, 0, 0], axis: ['Home', '0', 'Away'], tone: 'accent' });
  checkOverlayTree({ type: 'sparkline', points: [0, 0, 0], axis: ['', '', ''] });
  for (const axis of [[], ['a'], ['a', 'b'], ['a', 'b', 'c', 'd'], ['1234567', 'b', 'c'], ['a', 1, 'c'], 'abc', [String.fromCharCode(9), 'b', 'c']]) {
    assert.throws(() => checkOverlayTree({ type: 'sparkline', points: [0, 0, 0], axis }), 'axis ' + JSON.stringify(axis));
  }
  for (const segments of [[], [segment], Array(5).fill(segment), [null, segment], [[], segment],
    [{ value: '1', fraction: 0 }, segment], [{ label: 'A', fraction: 0 }, segment],
    [{ ...segment, label: 'x'.repeat(25) }, segment], [{ ...segment, value: 'x'.repeat(17) }, segment],
    [{ ...segment, label: String.fromCharCode(10) }, segment],
    [{ ...segment, fraction: -0.1 }, segment], [{ ...segment, fraction: 1.1 }, segment],
    [{ ...segment, fraction: true }, segment], [{ ...segment, fraction: NaN }, segment],
    [{ ...segment, fraction: undefined }, segment], [{ ...segment, tone: 'red' }, segment]]) {
    assert.throws(() => checkOverlayTree({ type: 'compare', segments }));
  }
  for (const points of [[], [0, 1], Array(25).fill(0), [-1.1, 0, 1], [-1, 0, 1.1], [0, true, 1], [0, NaN, 1], [0, '0', 1]]) {
    assert.throws(() => checkOverlayTree({ type: 'sparkline', points }));
  }
  assert.throws(() => checkOverlayTree({ type: 'sparkline', points: [0, 0, 0], tone: 'red' }));
  assert.throws(() => checkOverlayTree({ type: 'compare' }));
  assert.throws(() => checkOverlayTree({ type: 'sparkline' }));
  assert.throws(() => checkOverlayTree({ type: 'image', src: 'https://example.com/image.png', shape: 'oval' }));
  for (const value of [null, [], {}, { type: '__proto__' }, { type: 'text' }, { type: 'text', text: '' },
    { type: 'stack', children: [] }, { type: 'row', children: Array(11).fill({ type: 'dot' }) },
    { type: 'text', text: 'x', tone: 'info' }, { type: 'text', text: 'x', color: 'red' },
    { type: 'text', text: String.fromCharCode(10) }, { type: 'text', text: 'x'.repeat(401) },
    { type: 'stack', gap: 0.5, children: [{ type: 'dot' }] },
    { type: 'progress', value: NaN }, { type: 'progress', value: true }, { type: 'progress', value: 1.01 },
    { type: 'countdown', target: 'tomorrow' }, { type: 'image', src: 'javascript:alert(1)' },
    { type: 'list', items: [] }, { type: 'list', items: ['x'.repeat(121)] }, { type: 'badge', text: 'x', tone: 'neutral' }]) {
    assert.throws(() => checkOverlayTree(value), JSON.stringify(value));
  }

  // --- the six new widgets: positive and negative ---
  for (const icon of Object.keys(OVERLAY_ICONS)) checkOverlayTree({ type: 'section', title: 'T', icon, action: 'x'.repeat(24) });
  checkOverlayTree({ type: 'section', title: 'x'.repeat(40) });
  for (const bad of [{ type: 'section' }, { type: 'section', title: '' }, { type: 'section', title: 'x'.repeat(41) },
    { type: 'section', title: 'T', icon: 'rocket' }, { type: 'section', title: 'T', icon: '' }, { type: 'section', title: 'T', action: 'x'.repeat(25) },
    { type: 'section', title: 'T', tone: 'info' }]) assert.throws(() => checkOverlayTree(bad), JSON.stringify(bad));
  for (const tone of OVERLAY_TONES) checkOverlayTree({ type: 'event', time: 'x'.repeat(8), text: 'x'.repeat(120), icon: 'ball', tone });
  checkOverlayTree({ type: 'event', time: '1', text: 'x' });
  for (const bad of [{ type: 'event', text: 'x' }, { type: 'event', time: '1' }, { type: 'event', time: 'x'.repeat(9), text: 'x' },
    { type: 'event', time: '1', text: 'x'.repeat(121) }, { type: 'event', time: '1', text: 'x', icon: 'nope' }, { type: 'event', time: '1', text: 'x', tone: 'red' }]) {
    assert.throws(() => checkOverlayTree(bad), JSON.stringify(bad));
  }
  for (const fraction of [0, 0.5, 1]) checkOverlayTree({ type: 'stat', label: 'x'.repeat(40), left: 'x'.repeat(16), right: 'x'.repeat(16), fraction, tone: 'accent' });
  for (const missing of ['label', 'left', 'right', 'fraction']) {
    const bad = { type: 'stat', label: 'L', left: '1', right: '2', fraction: 0.5 };
    delete bad[missing];
    assert.throws(() => checkOverlayTree(bad), 'stat without ' + missing);
  }
  for (const fraction of [-0.01, 1.01, '0.5', NaN, true]) assert.throws(() => checkOverlayTree({ type: 'stat', label: 'L', left: '1', right: '2', fraction }));
  assert.throws(() => checkOverlayTree({ type: 'stat', label: 'L', left: 'x'.repeat(17), right: '2', fraction: 0.5 }));
  for (const state of OVERLAY_STATES) checkOverlayTree({ type: 'status', label: 'x'.repeat(40), state, detail: 'x'.repeat(24) });
  checkOverlayTree({ type: 'status', label: 'S', state: 'online' });
  for (const bad of [{ type: 'status', label: 'S' }, { type: 'status', state: 'online' }, { type: 'status', label: 'S', state: 'up' },
    { type: 'status', label: 'S', state: 'online', detail: 'x'.repeat(25) }, { type: 'status', label: 'S', state: 'online', tone: 'info' }]) {
    assert.throws(() => checkOverlayTree(bad), JSON.stringify(bad));
  }
  const fact = { label: 'x'.repeat(24), value: 'x'.repeat(40), icon: 'pin' };
  for (const length of [1, 2, 3, 4]) checkOverlayTree({ type: 'meta', items: Array.from({ length }, () => ({ ...fact })) });
  checkOverlayTree({ type: 'meta', items: [{ label: 'L', value: 'V' }] });
  for (const items of [[], Array(5).fill(fact), [null], ['text'], [{ label: 'L' }], [{ value: 'V' }], [{ label: '', value: 'V' }],
    [{ ...fact, label: 'x'.repeat(25) }], [{ ...fact, value: 'x'.repeat(41) }], [{ ...fact, icon: 'nope' }], [{ ...fact, tone: 'info' }]]) {
    assert.throws(() => checkOverlayTree({ type: 'meta', items }), JSON.stringify(items));
  }
  assert.throws(() => checkOverlayTree({ type: 'meta' }));
  for (const format of ['time', 'seconds', 'date']) checkOverlayTree({ type: 'clock', format, label: 'x'.repeat(40) });
  checkOverlayTree({ type: 'clock' });
  assert.throws(() => checkOverlayTree({ type: 'clock', format: 'iso' }));
  assert.throws(() => checkOverlayTree({ type: 'clock', label: 'x'.repeat(41) }));

  // --- caps: depth 5, 80 widgets across regions, 49152 bytes ---
  let deep = { type: 'dot' };
  for (let i = 0; i < 4; i++) deep = { type: 'stack', children: [deep] };
  checkOverlayTree(deep);
  assert.throws(() => checkOverlayTree({ type: 'stack', children: [deep] }), /5 levels deep/);
  const eighty = { type: 'stack', children: [20, 20, 20, 16].map(length => ({
    type: 'stack', children: Array.from({ length }, () => ({ type: 'dot' })),
  })) };
  assert.equal(overlayNodeCount(eighty), 81);
  assert.throws(() => checkOverlayTree(eighty), /80 widgets/);
  eighty.children[3].children.pop();
  assert.equal(overlayNodeCount(eighty), 80);
  checkOverlayTree(eighty);
  const large = { type: 'stack', children: [20, 11].map(length => ({ type: 'stack',
    children: Array.from({ length }, () => ({ type: 'text', text: '😀'.repeat(400) })) })) };
  assert.throws(() => checkOverlayTree(large), /49152/);
  assert.throws(() => checkOverlayCard({ root: large }), /49152/);
  const forty = { type: 'stack', children: [20, 17].map(length => ({ type: 'stack', children: Array.from({ length }, () => ({ type: 'dot' })) })) };
  assert.equal(overlayNodeCount(forty), 40);
  checkOverlayCard({ regions: [{ position: 'top', root: forty }, { position: 'right', root: forty }] });
  assert.throws(() => checkOverlayCard({ regions: [{ position: 'top', root: forty }, { position: 'right', root: forty }, { position: 'center', root: { type: 'dot' } }] }), /80 widgets/);
  assert.equal(overlayCardCount({ regions: [{ position: 'top', root: forty }, { position: 'right', root: forty }] }), 80);

  // --- whole-card envelope: single card or regions, seconds, theme ---
  const dot = { type: 'dot' };
  checkOverlayCard({ root: dot });
  checkOverlayCard({ root: dot, position: 'left', size: 'full', seconds: 0 });
  checkOverlayCard({ root: dot, seconds: 300 });
  for (const position of Object.keys(OVERLAY_POSITIONS)) checkOverlayCard({ regions: [{ position, size: 'xs', root: dot }] });
  checkOverlayCard({ regions: [{ position: 'top', root: dot }, { position: 'right', root: dot }, { position: 'bottom', root: dot }, { position: 'left', root: dot }] });
  for (const bad of [null, [], 'card', {}, { root: dot, seconds: -1 }, { root: dot, seconds: 301 }, { root: dot, seconds: 1.5 }, { root: dot, seconds: '8' },
    { root: dot, position: 'middle' }, { root: dot, size: 'xxl' }, { root: dot, title: 'x' }, { root: dot, position: 'top', regions: [{ position: 'top', root: dot }] },
    { regions: [] }, { regions: Array(5).fill({ position: 'top', root: dot }) }, { regions: {} }, { regions: [null] }, { regions: [{ root: dot }] },
    { regions: [{ position: 'nowhere', root: dot }] }, { regions: [{ position: 'top' }] }, { regions: [{ position: 'top', root: dot, seconds: 1 }] },
    { regions: [{ position: 'top', root: dot }, { position: 'top', root: dot }] }]) {
    assert.throws(() => checkOverlayCard(bad), JSON.stringify(bad));
  }
  const theme = { accent: '#E8C35A', surface: '#191c22', text: '#f0f2f5', muted: '#c4c9d2', line: '#3a3d43', opacity: 0.2, radius: 0, scale: 0.75, font: 'condensed' };
  checkOverlayTheme(theme);
  checkOverlayCard({ root: dot, theme });
  checkOverlayCard({ regions: [{ position: 'top', root: dot }], theme: { opacity: 1, radius: 32, scale: 1.5, font: 'mono' } });
  checkOverlayCard({ root: dot, theme: {} });
  for (const bad of [null, [], 'dark', { accent: 'red' }, { accent: '#fff' }, { accent: '#gggggg' }, { accent: '#1234567' }, { surface: 'rgb(0 0 0)' },
    { opacity: 0.19 }, { opacity: 1.01 }, { opacity: '0.5' }, { radius: -1 }, { radius: 33 }, { radius: 2.5 }, { scale: 0.74 }, { scale: 1.51 },
    { font: 'serif' }, { font: '' }, { shadow: true }, { color: '#000000' }]) {
    assert.throws(() => checkOverlayTheme(bad), JSON.stringify(bad));
    assert.throws(() => checkOverlayCard({ root: dot, theme: bad }), JSON.stringify(bad));
  }

  // --- templates: every one validates, uses placeholder text only, and the broadcast one covers the HUD vocabulary ---
  const templates = overlayTemplates();
  assert.ok(templates.length >= 5 && templates.length <= 6);
  const types = (node) => [node.type, ...(node.children || []).flatMap(types)];
  for (const template of templates) {
    assert.ok(template.name && template.blurb);
    assert.equal(checkOverlayCard(template.card), template.card);
    assert.ok(overlayCardCount(template.card) <= 80);
  }
  const broadcast = templates[0].card;
  assert.deepEqual(broadcast.regions.map(r => r.position), ['top', 'right']);
  const used = new Set(broadcast.regions.flatMap(r => types(r.root)));
  for (const type of ['image', 'text', 'clock', 'badge', 'section', 'event', 'stat', 'compare', 'sparkline', 'status']) assert.ok(used.has(type), 'broadcast uses ' + type);
  assert.equal(broadcast.regions[1].root.children.find(n => n.type === 'compare').segments.length, 3, 'three-way win probability');
  assert.equal(broadcast.regions[1].root.children.find(n => n.type === 'sparkline').axis.length, 3, 'momentum chart has axis labels');
  assert.equal(broadcast.regions[0].root.children.find(n => n.type === 'badge').tone, 'accent', 'LIVE badge is accent-outlined');
  const text = JSON.stringify(templates);
  for (const real of [/Barcelona|Madrid|Liverpool|Arsenal|Messi|Ronaldo|Haaland|Premier|Bundesliga/iu]) assert.doesNotMatch(text, real);
  assert.match(text, /Home team/);
  assert.match(text, /Source A/);

  // --- previews mirror the TV DOM ---
  const comparison = previewOverlayNode({ type: 'compare', segments: [segment, { ...segment, fraction: 1 }] });
  assert.equal(comparison.className, 'w-compare');
  assert.equal(comparison.children[0].className, 'w-compare-labels');
  assert.equal(comparison.children[0].children[0].children[1].dataset.tone, 'success');
  assert.equal(comparison.children[1].className, 'w-compare-bar');
  assert.equal(comparison.children[1].children[1].style.width, '100%');
  const sparkline = previewOverlayNode({ type: 'sparkline', points: [-1, 0, 0.5] });
  assert.equal(sparkline.className, 'w-sparkline');
  assert.equal(sparkline.dataset.tone, 'info');
  assert.equal(sparkline.children[0].className, 'w-sparkline-cols');
  assert.equal(sparkline.children[0].children[0].className, 'w-sparkline-col');
  assert.equal(sparkline.children[0].children[0].children[0].dataset.sign, 'neg');
  assert.equal(sparkline.children[0].children[0].children[0].style.height, '50%');
  assert.equal(sparkline.children[0].children[2].children[0].style.height, '25%');
  const axed = previewOverlayNode({ type: 'sparkline', points: [0, 0, 0], axis: ['Top', '0', 'Low'], tone: 'accent' });
  assert.equal(axed.children[0].className, 'w-sparkline-axis');
  assert.equal(JSON.stringify(axed.children[0].children.map(s => s.textContent)), JSON.stringify(['Top', '0', 'Low']));
  assert.equal(axed.children[1].className, 'w-sparkline-cols');
  assert.equal(previewOverlayNode({ type: 'image', src: 'https://example.com/image.png', shape: 'circle' }).dataset.shape, 'circle');
  assert.equal(previewOverlayNode({ type: 'image', src: 'https://example.com/image.png' }).dataset.shape, 'square');
  assert.equal(previewOverlayNode({ type: 'image', src: 'https://example.com/image.png', size: 'l' }).dataset.size, 'l');
  assert.equal(previewOverlayNode({ type: 'image', src: 'https://example.com/image.png' }).dataset.size, 'm');
  const section = previewOverlayNode({ type: 'section', title: 'Stats', icon: 'chart', action: 'A · B' });
  assert.equal(section.children[0].tag, 'svg');
  assert.equal(section.children[0].children[0].d, OVERLAY_ICONS.chart);
  assert.equal(section.children[1].className, 'w-section-title');
  assert.equal(section.children[2].className, 'w-section-action');
  const event = previewOverlayNode({ type: 'event', time: '12', text: 'Goal', tone: 'success' });
  assert.equal(JSON.stringify(event.children.map(c => c.className)), JSON.stringify(['w-event-time', 'w-event-mark', 'w-event-text']));
  assert.equal(event.children[1].children.length, 0, 'no icon leaves an empty mark (a dot on the TV)');
  assert.equal(previewOverlayNode({ type: 'event', time: '12', text: 'Goal', icon: 'ball' }).children[1].children[0].tag, 'svg');
  const stat = previewOverlayNode({ type: 'stat', label: 'Shots', left: '7', right: '3', fraction: 0.7 });
  assert.equal(stat.dataset.tone, 'accent');
  assert.equal(JSON.stringify(stat.children.map(c => c.className)), JSON.stringify(['w-stat-label', 'w-stat-left', 'w-stat-bar', 'w-stat-right']));
  assert.equal(stat.children[2].children[0].style.width, '70%');
  const status = previewOverlayNode({ type: 'status', label: 'Feed', state: 'degraded', detail: 'Slow' });
  assert.equal(status.dataset.state, 'degraded');
  assert.equal(status.children[1].textContent, 'Degraded');
  assert.equal(status.children[2].textContent, 'Slow');
  const meta = previewOverlayNode({ type: 'meta', items: [{ label: 'A', value: '1', icon: 'pin' }, { label: 'B', value: '2' }] });
  assert.equal(meta.children.length, 2);
  assert.equal(meta.children[0].className, 'w-meta-cell');
  assert.equal(meta.children[0].children[1].children[1].tag, 'svg');
  const clock = previewOverlayNode({ type: 'clock', format: 'seconds', label: 'Now' });
  assert.equal(clock.children[0].className, 'w-clock-face');
  assert.equal(clock.children[0].dataset.format, 'seconds');
  assert.equal(clock.children[1].textContent, 'Now');
  assert.equal(previewOverlayNode({ type: 'clock' }).children[0].dataset.format, 'time');
  assert.equal(previewOverlayNode({ type: 'badge', text: 'Live', tone: 'accent' }).dataset.tone, 'accent');
  assert.equal(previewOverlayNode({ type: 'list', items: ['a'] }).tag, 'ul');

  // --- the TV stage: regions land where the TV puts them and the theme becomes the TV's custom properties ---
  const stage = document.createElement('div');
  renderTvStage(stage, broadcast);
  const screen = stage.children[0];
  assert.equal(screen.className, 'tv-screen');
  assert.equal(JSON.stringify(screen.children.map(card => [card.dataset.pos, card.dataset.size])), JSON.stringify([['top', 'full'], ['right', 'm']]));
  assert.equal(stage.style['--tv-accent'], '#e8c35a');
  assert.equal(stage.dataset.font, 'condensed');
  assert.equal(stage.style['--tv-surface'], undefined, 'unset background keeps the TV default');
  renderTvStage(stage, { root: dot, theme: { surface: '#102030', opacity: 0.5, radius: 4, scale: 1.25 } });
  assert.equal(stage.style['--tv-surface'], 'rgb(16 32 48 / 0.5)');
  assert.equal(stage.style['--tv-radius'], '4px');
  assert.equal(stage.style['--tv-scale'], '1.25');
  assert.equal(stage.style['--tv-accent'], undefined, 'the previous theme is cleared');
  assert.equal(stage.dataset.font, 'sans');
  assert.equal(JSON.stringify(stage.children[0].children.map(card => card.dataset.pos)), JSON.stringify(['top-right']));
  renderTvStage(stage, { root: dot, theme: { opacity: 0.3 } });
  assert.equal(stage.style['--tv-surface'], 'rgb(25 28 34 / 0.3)', 'opacity alone keeps the default surface colour');

  // --- the builder ---
  updateOverlayDraft = () => {};
  overlayCard = { root: newOverlayNode('compare') };
  let builder = overlayBuilder(overlayCard.root);
  assert.equal(walk(builder).filter(el => el.tag === 'input').length, 6, 'each segment has label, value and share inputs');
  assert.equal(button(builder, 'Remove segment').disabled, true);
  button(builder, 'Add segment').listeners.click();
  builder = overlayBuilder(overlayCard.root);
  button(builder, 'Add segment').listeners.click();
  builder = overlayBuilder(overlayCard.root);
  assert.equal(overlayCard.root.segments.length, 4);
  assert.equal(button(builder, 'Add segment').disabled, true);
  button(builder, 'Remove segment').listeners.click();
  assert.equal(overlayCard.root.segments.length, 3);
  const colour = walk(overlayBuilder(overlayCard.root)).find(el => el.tag === 'select' && el.children.some(option => option.textContent === 'Default'));
  colour.value = 'alert'; colour.listeners.input();
  assert.equal(overlayCard.root.segments[0].tone, 'alert');
  colour.value = ''; colour.listeners.input();
  assert.equal(overlayCard.root.segments[0].tone, undefined);
  const chart = newOverlayNode('sparkline');
  let chartBuilder = overlayBuilder(chart);
  const points = walk(chartBuilder).find(el => el.tag === 'textarea');
  points.value = '-1, 0 1'; points.listeners.input();
  assert.equal(JSON.stringify(chart.points), '[-1,0,1]');
  checkOverlayTree(chart);
  const axis = walk(chartBuilder).filter(el => el.tag === 'input' && el['aria-label']?.startsWith('Axis label'));
  assert.equal(axis.length, 3);
  axis[0].value = 'Up'; axis[0].listeners.input();
  assert.deepEqual(chart.axis, ['Up', '', '']);
  checkOverlayTree(chart);
  axis[0].value = ''; axis[0].listeners.input();
  assert.equal(chart.axis, undefined, 'three empty axis labels leave axis out');
  points.value = '0, nope, 1'; points.listeners.input();
  assert.throws(() => checkOverlayTree(chart));
  const facts = newOverlayNode('meta');
  let factBuilder = overlayBuilder(facts);
  assert.equal(button(factBuilder, 'Remove fact').disabled, true, 'one fact must stay');
  for (let i = 0; i < 3; i++) { button(factBuilder, 'Add fact').listeners.click(); factBuilder = overlayBuilder(facts); }
  assert.equal(facts.items.length, 4);
  assert.equal(button(factBuilder, 'Add fact').disabled, true);
  const factIcon = walk(factBuilder).find(el => el.tag === 'select' && el.children.some(option => option.textContent === 'None'));
  factIcon.value = 'pin'; factIcon.listeners.input();
  assert.equal(facts.items[0].icon, 'pin');
  assert.equal(factIcon.parent.children[1].children[0].tag, 'svg', 'the chosen glyph is drawn beside the picker');
  factIcon.value = ''; factIcon.listeners.input();
  assert.equal(facts.items[0].icon, undefined);
  checkOverlayTree(facts);
  const sectionNode = newOverlayNode('section');
  const sectionIcon = walk(overlayBuilder(sectionNode)).find(el => el.tag === 'select' && el.children.some(option => option.textContent === 'None'));
  assert.equal(sectionIcon.children.length, 17, 'none plus the 16 TV icons');
  assert.equal(sectionIcon.children.find(option => option.selected).value, 'layers');
  const statNode = newOverlayNode('stat');
  const statInputs = inputs(overlayBuilder(statNode));
  assert.equal(statInputs.find(el => el.type === 'range').value, 0.5, 'the left share is a slider');
  const statTone = statInputs.find(el => el.tag === 'select' && el.children.some(o => o.value === 'accent'));
  assert.equal(statTone.children.find(o => o.selected).value, 'accent', 'stat defaults to the accent colour');
  const statusNode = newOverlayNode('status');
  const stateSelect = inputs(overlayBuilder(statusNode)).find(el => el.tag === 'select' && el.children.some(o => o.value === 'degraded'));
  stateSelect.value = 'offline'; stateSelect.listeners.input();
  assert.equal(statusNode.state, 'offline');
  const detail = inputs(overlayBuilder(statusNode)).find(el => el.maxlength === 24);
  detail.value = ''; detail.listeners.input();
  assert.equal(Object.hasOwn(statusNode, 'detail'), false, 'an emptied optional field is left out');

  // move / duplicate / remove, and the 80-widget cap across regions
  overlayCard = { root: { type: 'stack', children: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'dot' }] } };
  builder = overlayBuilder(overlayCard.root);
  const widgets = walk(builder).filter(el => el.className === 'overlay-widget' && el !== builder);
  assert.equal(widgets.length, 3);
  assert.equal(button(widgets[0], 'Move up').disabled, true);
  assert.equal(button(widgets[2], 'Move down').disabled, true);
  button(widgets[0], 'Move down').listeners.click();
  assert.equal(JSON.stringify(overlayCard.root.children.map(c => c.text || c.type)), JSON.stringify(['B', 'A', 'dot']));
  builder = overlayBuilder(overlayCard.root);
  button(walk(builder).filter(el => el.className === 'overlay-widget' && el !== builder)[2], 'Move up').listeners.click();
  assert.equal(JSON.stringify(overlayCard.root.children.map(c => c.text || c.type)), JSON.stringify(['B', 'dot', 'A']));
  builder = overlayBuilder(overlayCard.root);
  button(walk(builder).filter(el => el.className === 'overlay-widget' && el !== builder)[0], 'Duplicate').listeners.click();
  assert.equal(JSON.stringify(overlayCard.root.children.map(c => c.text || c.type)), JSON.stringify(['B', 'B', 'dot', 'A']));
  assert.notEqual(overlayCard.root.children[0], overlayCard.root.children[1], 'a duplicate is a copy, not a shared object');
  builder = overlayBuilder(overlayCard.root);
  button(walk(builder).filter(el => el.className === 'overlay-widget' && el !== builder)[1], 'Remove widget').listeners.click();
  assert.equal(JSON.stringify(overlayCard.root.children.map(c => c.text || c.type)), JSON.stringify(['B', 'dot', 'A']));
  overlayCard = { regions: [{ position: 'top', root: forty }, { position: 'right', root: { type: 'stack', children: Array.from({ length: 19 }, () => ({ type: 'dot' })) } }] };
  assert.equal(overlayCardCount(), 60);
  assert.notEqual(button(overlayBuilder(overlayCard.regions[1].root), 'Add widget').disabled, true);
  overlayCard.regions[1].root.children.push(...Array.from({ length: 20 }, () => ({ type: 'dot' })));
  assert.equal(overlayCardCount(), 80);
  assert.equal(button(overlayBuilder(overlayCard.regions[1].root), 'Add widget').disabled, true, 'the cap counts every region');
  assert.equal(button(overlayBuilder(forty.children[0], 2, forty, 0), 'Duplicate').disabled, true);
  overlayCard = { root: newOverlayNode('stack') };
  assert.notEqual(button(overlayBuilder(overlayCard.root, 4), 'Add widget').disabled, true);
  assert.equal(button(overlayBuilder(overlayCard.root, 5), 'Add widget').disabled, true);

  // regions: unique positions, add/remove
  overlayCard = { regions: [{ position: 'top', size: 'full', root: dot }, { position: 'right', size: 's', root: dot }] };
  let regionBoxes = overlayRegions().map((region, i) => regionControls(region, i, overlayCard.regions));
  const positionSelect = inputs(regionBoxes[1]).find(el => el.tag === 'select' && el.children.some(o => o.value === 'top'));
  assert.equal(positionSelect.children.find(o => o.value === 'top').disabled, true, 'a position used by another region is disabled');
  assert.equal(positionSelect.children.find(o => o.value === 'right').disabled, undefined);
  assert.equal(positionSelect.children.find(o => o.value === 'bottom').disabled, undefined);
  assert.equal(inputs(regionBoxes[1]).find(el => el.tag === 'select' && el.children.some(o => o.value === 'full')).children.find(o => o.selected).value, 's');
  button(regionBoxes[0], 'Remove region').listeners.click();
  assert.deepEqual(overlayCard.regions.map(r => r.position), ['right']);
  regionBoxes = overlayRegions().map((region, i) => regionControls(region, i, overlayCard.regions));
  assert.equal(button(regionBoxes[0], 'Remove region').disabled, true, 'the last region stays');
  const single = { position: 'center', root: dot };
  overlayCard = single;
  const singleBox = regionControls(single, 0, [single]);
  assert.equal(button(singleBox, 'Remove region'), undefined);
  assert.equal(singleBox.children[0].textContent, 'Card');

  // --- the Look form writes the card's theme object; unset values stay out of the JSON ---
  const themeState = {};
  let changes = 0;
  const form = themeForm(themeState, () => changes++);
  const colourInputs = inputs(form).filter(el => el.type === 'color');
  assert.equal(colourInputs.length, 5);
  assert.equal(colourInputs[0].value, '#84b5ec', 'unset accent shows the TV default');
  colourInputs[0].value = '#ff8800'; colourInputs[0].listeners.input();
  const ranges = inputs(form).filter(el => el.type === 'range');
  assert.equal(ranges.length, 3);
  ranges[0].value = '0.5'; ranges[0].listeners.input();
  ranges[1].value = '8'; ranges[1].listeners.input();
  ranges[2].value = '1.25'; ranges[2].listeners.input();
  const font = inputs(form).find(el => el.tag === 'select');
  font.value = 'mono'; font.listeners.change();
  assert.equal(JSON.stringify(themeState), JSON.stringify({ accent: '#ff8800', opacity: 0.5, radius: 8, scale: 1.25, font: 'mono' }));
  assert.equal(changes, 5);
  checkOverlayTheme(themeState);
  const clear = buttons(form).find(el => el.textContent === 'Clear');
  assert.ok(!clear.disabled, 'a set colour can be cleared');
  clear.listeners.click();
  assert.equal(colourInputs[0].value, '#84b5ec');
  assert.equal(clear.disabled, true);
  ranges[1].value = '16'; ranges[1].listeners.input();
  font.value = 'sans'; font.listeners.change();
  assert.equal(JSON.stringify(themeState), JSON.stringify({ opacity: 0.5, scale: 1.25 }), 'defaults and cleared colours are omitted');
  const compact = themeForm({ accent: '#123456' }, () => {}, ['accent', 'surface', 'opacity']);
  assert.equal(inputs(compact).filter(el => el.type === 'color').length, 2);
  assert.equal(inputs(compact).filter(el => el.type === 'range').length, 1);
  assert.equal(inputs(compact).filter(el => el.tag === 'select').length, 0);
  assert.ok(!buttons(compact)[0].disabled);
  assert.equal(buttons(compact)[1].disabled, true);
  for (const control of inputs(form)) assert.ok(control['aria-label'] || control.parent.tag === 'label', 'every Look control is labelled');

  // the empty Look object the form edits in place is stripped from the request body
  overlayCard = { position: 'top-right', seconds: 8, theme: {}, root: dot };
  assert.equal(JSON.stringify(overlayBody()), JSON.stringify({ position: 'top-right', seconds: 8, root: dot }));
  overlayCard.theme.accent = '#ffffff';
  assert.equal(overlayBody().theme.accent, '#ffffff');
  assert.equal(designSummary({ regions: [{ position: 'top', root: dot }, { position: 'right', root: forty }], seconds: 0 }), '2 regions · Top bar, Right panel · 41 widgets · stays until hidden');
  assert.equal(designSummary({ root: dot }), 'Single card · Top right · 1 widget · 8 s');
  consoleResult = 'check-overlay: ok (' + Object.keys(OVERLAY_FIELDS).length + ' widget types, v4 schema: regions, theme, caps depth-5/80-widget/49152-byte, '
    + templates.length + ' templates, builder controls, Look form, TV stage, previews)';
`, context);
console.log(context.consoleResult);
