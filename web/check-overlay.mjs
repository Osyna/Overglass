// Run: node web/check-overlay.mjs (no server, browser or TV required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({
  assert, TextEncoder, URL,
  document: { addEventListener() {} },
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
  for (let i = 0; i < 3; i++) deep = { type: 'stack', children: [deep] };
  checkOverlayTree(deep);
  assert.throws(() => checkOverlayTree({ type: 'stack', children: [deep] }), /4 levels/);
  const forty = { type: 'stack', children: [
    { type: 'stack', children: Array.from({ length: 20 }, () => ({ type: 'dot' })) },
    { type: 'stack', children: Array.from({ length: 17 }, () => ({ type: 'dot' })) },
  ] };
  assert.equal(overlayNodeCount(forty), 40);
  checkOverlayTree(forty);
  forty.children[1].children.push({ type: 'dot' });
  assert.throws(() => checkOverlayTree(forty), /40 widgets/);
  const large = { type: 'stack', children: [20, 1].map(length => ({ type: 'stack',
    children: Array.from({ length }, () => ({ type: 'text', text: '😀'.repeat(400) })) })) };
  assert.throws(() => checkOverlayTree(large), /32768/);
  consoleResult = 'check-overlay: ok (10 widget types, schema fields, nesting, node and byte caps)';
`, context);
console.log(context.consoleResult);
