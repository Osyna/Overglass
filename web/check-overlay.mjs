// Run: node web/check-overlay.mjs (no server, browser or TV required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; }
  setAttribute(name, value) { this[name] = ['disabled', 'selected'].includes(name) ? true : value; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}
const context = vm.createContext({
  assert, TextEncoder, URL,
  document: { addEventListener() {}, createElement: tag => new Element(tag) },
});
vm.runInContext(fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8'), context);
vm.runInContext(`
  for (const type of Object.keys(OVERLAY_FIELDS)) {
    const node = newOverlayNode(type);
    assert.equal(checkOverlayTree(node), node);
  }
  const nested = { type: 'stack', gap: 48, align: 'end', children: [
    { type: 'row', children: [{ type: 'badge', text: 'Ready', tone: 'success' }, { type: 'dot' }] },
    { type: 'progress', value: 1, label: 'Done', tone: 'info' },
    { type: 'text', text: '<script>not HTML</script>', size: 'xl', weight: 'strong', color: 'warning' },
    { type: 'list', items: ['One', 'Two'], style: 'number' }, { type: 'divider' },
  ] };
  assert.equal(checkOverlayTree(nested), nested);
  assert.equal(overlayNodeCount(nested), 8);
  for (const shape of ['square', 'circle']) checkOverlayTree({ type: 'image', src: 'https://example.com/image.png', shape });
  const segment = { label: 'x'.repeat(24), value: 'x'.repeat(16), fraction: 0, tone: 'success' };
  for (const length of [2, 3, 4]) checkOverlayTree({ type: 'compare', segments: Array.from({ length }, () => ({ ...segment, fraction: 1 })) });
  for (const length of [3, 24]) checkOverlayTree({ type: 'sparkline', points: Array.from({ length }, (_, i) => i % 2 ? -1 : 1), tone: 'warning' });
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
  for (const value of [null, [], {}, { type: '__proto__' }, { type: 'text' },
    { type: 'stack', children: [] }, { type: 'row', children: Array(11).fill({ type: 'dot' }) },
    { type: 'text', text: 'x', tone: 'info' }, { type: 'text', text: 'x', color: 'red' },
    { type: 'text', text: String.fromCharCode(10) }, { type: 'text', text: 'x'.repeat(401) },
    { type: 'stack', gap: 0.5, children: [{ type: 'dot' }] },
    { type: 'progress', value: NaN }, { type: 'progress', value: true }, { type: 'progress', value: 1.01 },
    { type: 'countdown', target: 'tomorrow' }, { type: 'image', src: 'javascript:alert(1)' },
    { type: 'list', items: [] }, { type: 'list', items: ['x'.repeat(121)] }]) {
    assert.throws(() => checkOverlayTree(value));
  }
  let deep = { type: 'dot' };
  for (let i = 0; i < 4; i++) deep = { type: 'stack', children: [deep] };
  checkOverlayTree(deep);
  assert.throws(() => checkOverlayTree({ type: 'stack', children: [deep] }), /5 levels deep/);
  const sixty = { type: 'stack', children: [20, 20, 16].map(length => ({
    type: 'stack', children: Array.from({ length }, () => ({ type: 'dot' })),
  })) };
  assert.equal(overlayNodeCount(sixty), 60);
  checkOverlayTree(sixty);
  sixty.children[2].children.push({ type: 'dot' });
  assert.throws(() => checkOverlayTree(sixty), /60 widgets/);
  sixty.children[2].children.pop();
  const large = { type: 'stack', children: [20, 1].map(length => ({ type: 'stack',
    children: Array.from({ length }, () => ({ type: 'text', text: '😀'.repeat(400) })) })) };
  assert.throws(() => checkOverlayTree(large), /32768/);
  const walk = el => [el, ...(el.children || []).filter(child => typeof child === 'object').flatMap(walk)];
  const buttons = el => walk(el).filter(child => child.tag === 'button');
  updateOverlayDraft = () => {};
  overlayRoot = newOverlayNode('compare');
  let builder = overlayBuilder(overlayRoot);
  assert.equal(walk(builder).filter(el => el.tag === 'input').length, 6, 'each segment has label, value and share inputs');
  assert.equal(buttons(builder).find(el => el.textContent === 'Remove segment').disabled, true);
  buttons(builder).find(el => el.textContent === 'Add segment').listeners.click();
  builder = overlayBuilder(overlayRoot);
  buttons(builder).find(el => el.textContent === 'Add segment').listeners.click();
  builder = overlayBuilder(overlayRoot);
  assert.equal(overlayRoot.segments.length, 4);
  assert.equal(buttons(builder).find(el => el.textContent === 'Add segment').disabled, true);
  buttons(builder).find(el => el.textContent === 'Remove segment').listeners.click();
  assert.equal(overlayRoot.segments.length, 3);
  const colour = walk(overlayBuilder(overlayRoot)).find(el => el.tag === 'select' && el.children.some(option => option.textContent === 'Default'));
  colour.value = 'alert'; colour.listeners.input();
  assert.equal(overlayRoot.segments[0].tone, 'alert');
  colour.value = ''; colour.listeners.input();
  assert.equal(overlayRoot.segments[0].tone, undefined);
  const chart = newOverlayNode('sparkline');
  const points = walk(overlayBuilder(chart)).find(el => el.tag === 'textarea');
  points.value = '-1, 0 1'; points.listeners.input();
  assert.equal(JSON.stringify(chart.points), '[-1,0,1]');
  checkOverlayTree(chart);
  points.value = '0, nope, 1'; points.listeners.input();
  assert.throws(() => checkOverlayTree(chart));
  overlayRoot = sixty;
  assert.equal(buttons(overlayBuilder(sixty)).find(el => el.textContent === 'Add widget').disabled, true);
  overlayRoot = newOverlayNode('stack');
  assert.notEqual(buttons(overlayBuilder(overlayRoot, 4)).find(el => el.textContent === 'Add widget').disabled, true);
  assert.equal(buttons(overlayBuilder(overlayRoot, 5)).find(el => el.textContent === 'Add widget').disabled, true);
  const comparison = previewOverlayNode({ type: 'compare', segments: [segment, { ...segment, fraction: 1 }] });
  assert.equal(comparison.className, 'w-compare');
  assert.equal(comparison.children[0].className, 'w-compare-labels');
  assert.equal(comparison.children[0].children[0].children[1].dataset.tone, 'success');
  assert.equal(comparison.children[1].className, 'w-compare-bar');
  assert.equal(comparison.children[1].children[1].style.width, '100%');
  const sparkline = previewOverlayNode({ type: 'sparkline', points: [-1, 0, 0.5] });
  assert.equal(sparkline.className, 'w-sparkline');
  assert.equal(sparkline.dataset.tone, 'info');
  assert.equal(sparkline.children[0].className, 'w-sparkline-col');
  assert.equal(sparkline.children[0].children[0].dataset.sign, 'neg');
  assert.equal(sparkline.children[0].children[0].style.height, '50%');
  assert.equal(sparkline.children[2].children[0].style.height, '25%');
  assert.equal(previewOverlayNode({ type: 'image', src: 'https://example.com/image.png', shape: 'circle' }).dataset.shape, 'circle');
  assert.equal(previewOverlayNode({ type: 'image', src: 'https://example.com/image.png' }).dataset.shape, 'square');
  consoleResult = 'check-overlay: ok (' + Object.keys(OVERLAY_FIELDS).length + ' widget types, v3 schema, builder controls, previews, depth-5/60-widget and byte caps)';
`, context);
console.log(context.consoleResult);
