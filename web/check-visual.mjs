#!/usr/bin/env node
// Node >=22 + Chromium + Python 3/Pillow. See docs/OVERLAY-VISUAL.md.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetRoot = path.resolve(here, '../tv-assets/overlay');
const width = 1920, height = 1080;
const frozenTime = '2026-01-15T12:34:56.000Z';
const options = { chromium: process.env.CHROMIUM || 'chromium', python: process.env.PYTHON || 'python3',
  references: path.join(here, 'visual-references'), host: '127.0.0.1', port: '0' };
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--update-references') options.update = true;
  else if (arg === '--help') {
    console.log(`Usage: node web/check-visual.mjs [--update-references]
  --chromium PATH     Chromium executable (or CHROMIUM)
  --python PATH       Python with Pillow (or PYTHON)
  --references DIR    Reference PNGs and manifest; default web/visual-references
  --output DIR        Actual captures, highlighted diffs and report.json
  --cdp HTTP_OR_WS    Attach to an existing browser/page (including a TV)
  --url URL          Actual overlay entrypoint; required with --cdp
  --host ADDRESS     Fixture server bind address; default 127.0.0.1
  --port NUMBER      Fixture server port; default random
Default compares committed references with ZERO changed pixels allowed.
Updating references is explicit, captures actual rendering, and still requires
its one-pixel DOM mutation negative control to fail comparison.`);
    process.exit(0);
  } else {
    const key = { '--chromium': 'chromium', '--python': 'python', '--references': 'references', '--output': 'output',
      '--cdp': 'cdp', '--url': 'url', '--host': 'host', '--port': 'port' }[arg];
    if (!key || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Unknown/incomplete option: ${arg}`);
    options[key] = process.argv[++index];
  }
}
assert(typeof WebSocket === 'function', 'Node >=22 is required (built-in WebSocket)');
assert(/^\d+$/.test(options.port) && Number(options.port) <= 65535, 'Invalid --port');
assert(!options.cdp || options.url, '--cdp requires --url pointing to the actual overlay entrypoint');
options.references = path.resolve(options.references);
const fixturesText = await readFile(path.join(here, 'visual-references/cases.json'), 'utf8');
const runtimeExpression = await readFile(path.resolve(here, '../tests/overlay-runtime.js'), 'utf8');
const fixtures = JSON.parse(fixturesText);
assert.equal(fixtures.length, 27, 'Keep all 27 overlay reference cases');
assert.equal(new Set(fixtures.map(fixture => fixture.name)).size, fixtures.length);
for (const fixture of fixtures) assert(/^[a-z0-9-]+$/.test(fixture.name), 'Unsafe fixture filename');
const fixtureHash = createHash('sha256').update(fixturesText).digest('hex');
const outputDir = options.output ? path.resolve(options.output) : await mkdtemp(path.join(tmpdir(), 'foundry-visual-'));
assert.notEqual(outputDir, options.references, 'Captures must not overwrite references');
await mkdir(outputDir, { recursive: true });
const pillow = spawnSync(options.python, ['-c', 'from PIL import Image, ImageChops'], { encoding: 'utf8' });
if (pillow.error || pillow.status !== 0) throw new Error(`Python 3 with Pillow is required: ${pillow.error?.message || pillow.stderr}`);
let manifest;
if (!options.update) {
  try { manifest = JSON.parse(await readFile(path.join(options.references, 'manifest.json'), 'utf8')); }
  catch (error) { throw new Error(`Missing/invalid visual references. Capture and review them with --update-references first. ${error.message}`); }
  assert.equal(manifest.fixtureHash, fixtureHash, 'Fixtures changed: explicitly recapture and review reference PNGs');
  assert.equal(manifest.width, width); assert.equal(manifest.height, height);
  assert.equal(manifest.frozenTime, frozenTime);
  assert.deepEqual(manifest.cases, fixtures.map(fixture => fixture.name));
}

const fixtureImage = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="#264d68"/><circle cx="60" cy="45" r="24" fill="#efc270"/><path d="M12 110L48 62L72 86L92 65L120 110Z" fill="#88c7aa"/></svg>';
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/visual-fixture.svg') { response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(fixtureImage); return; }
    if (!pathname.startsWith('/overlay/')) { response.writeHead(404).end(); return; }
    const filename = path.resolve(assetRoot, pathname.slice('/overlay/'.length));
    if (!filename.startsWith(assetRoot + path.sep)) { response.writeHead(403).end(); return; }
    const contents = await readFile(filename);
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(contents);
  } catch { response.writeHead(404).end(); }
});
if (options.url) assert(['http:', 'https:', 'file:'].includes(new URL(options.url).protocol), 'Use an http(s) or file overlay URL');
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(options.port), options.host, resolve); });
const localUrl = `http://127.0.0.1:${server.address().port}/overlay/index.html`;
const overlayUrl = options.url || localUrl;
console.log(`Overlay: ${overlayUrl}\nCaptures: ${outputDir}`);

class CDP {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else for (const callback of this.listeners.get(message.method) || []) callback(message.params);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP connection closed')); }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, callback) { this.listeners.set(method, [...(this.listeners.get(method) || []), callback]); }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

async function connect(endpoint) {
  let websocket = endpoint;
  if (!/^wss?:/.test(endpoint)) {
    const response = await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(10000) });
    assert(response.ok, `Cannot discover CDP pages (${response.status})`);
    const targets = await response.json();
    const target = targets.find(target => target.type === 'page' && target.url === overlayUrl) || targets.find(target => target.type === 'page');
    assert(target?.webSocketDebuggerUrl, 'No debuggable page: launch the overlay app or open a browser tab first');
    websocket = target.webSocketDebuggerUrl;
  }
  const socket = new WebSocket(websocket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP socket timed out')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Cannot connect CDP socket: ${websocket}`)); }, { once: true });
  });
  return new CDP(socket);
}

const preload = `(() => {
  const NativeDate = Date, fixed = ${JSON.stringify(Date.parse(frozenTime))};
  function FrozenDate(...args) {
    if (!new.target) return new NativeDate(fixed).toString();
    return Reflect.construct(NativeDate, args.length ? args : [fixed], new.target);
  }
  Object.setPrototypeOf(FrozenDate, NativeDate); FrozenDate.prototype = NativeDate.prototype;
  FrozenDate.now = () => fixed; window.Date = FrozenDate;
  // Fonts and rendering stay production-owned; only time and motion are frozen.
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';
  const install = () => document.documentElement.appendChild(style);
  if (document.documentElement) install(); else document.addEventListener('DOMContentLoaded', install, { once: true });
})();`;

function nodeCounts(card) {
  const counts = {};
  const walk = node => { counts[node.type] = (counts[node.type] || 0) + 1; for (const child of node.children || []) walk(child); };
  const active = card.timeline ? card.timeline[0].card : card;
  for (const region of active.regions || [active]) walk(region.root);
  return counts;
}

const comparePython = `import json, sys
from PIL import Image, ImageChops
results = []
for pair in json.load(sys.stdin):
    expected, actual = Image.open(pair['expected']).convert('RGBA'), Image.open(pair['actual']).convert('RGBA')
    if expected.size != (1920, 1080) or actual.size != expected.size:
        results.append(dict(name=pair['name'], passed=False, error='Expected 1920x1080, got %s / %s' % (expected.size, actual.size)))
        continue
    channels = ImageChops.difference(expected, actual).split()
    mask = channels[0]
    for channel in channels[1:]: mask = ImageChops.lighter(mask, channel)
    histogram = mask.histogram()
    changed = sum(histogram[1:])
    if changed and pair.get('diff'):
        visible = mask.point(lambda value: 255 if value else 0)
        Image.composite(Image.new('RGB', actual.size, '#ff2040'), actual.convert('RGB').point(lambda value: value // 3), visible).save(pair['diff'])
    results.append(dict(name=pair['name'], passed=changed == 0, changedPixels=changed, maxChannelDelta=max(index for index, count in enumerate(histogram) if count), bounds=mask.getbbox()))
print(json.dumps(results))`;
function compare(pairs) {
  const result = spawnSync(options.python, ['-c', comparePython], { input: JSON.stringify(pairs), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Pixel comparison failed: ${result.error?.message || result.stderr}`);
  return JSON.parse(result.stdout);
}

let browser, profile, cdp;
try {
  let endpoint = options.cdp;
  if (!endpoint) {
    profile = await mkdtemp(path.join(tmpdir(), 'foundry-chromium-'));
    browser = spawn(options.chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--font-render-hinting=none', '--disable-lcd-text', '--lang=en-US', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    let launchError, browserLog = '';
    browser.on('error', error => { launchError = error; });
    browser.stderr.on('data', data => { browserLog = (browserLog + data).slice(-4000); });
    const deadline = Date.now() + 20000;
    while (!endpoint && Date.now() < deadline) {
      if (launchError) throw launchError;
      if (browser.exitCode !== null) throw new Error(`Chromium exited (${browser.exitCode}): ${browserLog}`);
      try { const port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; endpoint = `http://127.0.0.1:${port}`; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(50); }
    }
    assert(endpoint, `Chromium did not expose CDP: ${browserLog}`);
  }
  cdp = await connect(endpoint);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 16, g: 24, b: 32, a: 1 } });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preload });
  const browserVersion = await cdp.send('Browser.getVersion');
  const exceptions = [];
  cdp.on('Runtime.exceptionThrown', params => exceptions.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text));
  let loadCallback;
  cdp.on('Page.loadEventFired', () => loadCallback?.());
  const capture = async filename => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    await writeFile(filename, Buffer.from(shot.data, 'base64'));
  };
  const pairs = [];
  let negativeActual, runtimeRegression;
  for (const fixture of fixtures) {
    exceptions.length = 0;
    const card = JSON.parse(JSON.stringify({ seconds: 0, position: 'top-right', size: 'm', ...fixture.card })
      .replaceAll('$IMAGE', new URL('/visual-fixture.svg', overlayUrl).href));
    let timer;
    const loaded = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Page load timed out: ${fixture.name}`)), 20000);
      loadCallback = resolve;
    });
    try {
      const navigation = await cdp.send('Page.navigate', { url: overlayUrl });
      assert(!navigation.errorText, navigation.errorText);
      await loaded;
    } finally { clearTimeout(timer); loadCallback = null; }
    if (!runtimeRegression) {
      await cdp.evaluate(`(async () => {
        await Promise.all(['Inter', 'Roboto Condensed', 'JetBrains Mono'].map(font => document.fonts.load('26px "' + font + '"')));
        await document.fonts.ready;
      })()`);
      runtimeRegression = await cdp.evaluate(runtimeExpression);
      assert.equal(runtimeRegression?.passed, true, 'Production DOM runtime regressions must pass');
      console.log(`PASS production DOM lifecycle: ${runtimeRegression.checks} render operations`);
    }
    await cdp.evaluate(`document.dispatchEvent(new CustomEvent('webOSRelaunch', { detail: ${JSON.stringify(card)} })); true`);
    const state = await cdp.evaluate(`(async () => {
      await Promise.all(['Inter', 'Roboto Condensed', 'JetBrains Mono'].map(font => document.fonts.load('26px "' + font + '"')));
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(image => new Promise((resolve, reject) => {
        if (image.complete) return image.naturalWidth ? resolve() : reject(new Error('Fixture image failed'));
        image.onload = resolve; image.onerror = () => reject(new Error('Fixture image failed'));
      })));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const counts = {};
      for (const type of ${JSON.stringify(Object.keys(nodeCounts(card)))}) counts[type] = document.querySelectorAll('.w-' + type).length;
      return { counts, cards: document.querySelectorAll('#stage .card.show').length,
        fonts: Array.from(document.fonts).filter(font => font.status === 'loaded').map(font => font.family.replace(/['"]/g, '')),
        now: new Date().toISOString(), viewport: [innerWidth, innerHeight, devicePixelRatio] };
    })()`);
    assert.deepEqual(state.counts, nodeCounts(card), `${fixture.name}: renderer dropped or duplicated a fixture widget`);
    const active = card.timeline ? card.timeline[0].card : card;
    assert.equal(state.cards, active.regions?.length || 1, `${fixture.name}: no visible cards`);
    for (const family of ['Inter', 'Roboto Condensed', 'JetBrains Mono']) assert(state.fonts.includes(family), `Bundled font did not load: ${family}`);
    assert.equal(state.now, frozenTime); assert.deepEqual(state.viewport, [width, height, 1]);
    assert.deepEqual(exceptions, [], `${fixture.name}: browser exception`);
    const actual = path.join(outputDir, `${fixture.name}.png`);
    await capture(actual);
    pairs.push({ name: fixture.name, expected: path.join(options.references, `${fixture.name}.png`), actual, diff: path.join(outputDir, `${fixture.name}.diff.png`) });
    if (!negativeActual) {
      negativeActual = path.join(outputDir, 'negative-control.png');
      await cdp.evaluate(`(() => { const pixel = document.createElement('div'); pixel.id = 'visual-negative-control'; pixel.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;background:#ff00ff;z-index:2147483647;'; document.body.appendChild(pixel); })()`);
      await capture(negativeActual);
      await cdp.evaluate(`document.getElementById('visual-negative-control').remove()`);
    }
    console.log(`Captured ${fixture.name}`);
  }
  const control = compare([{ name: 'one-pixel DOM mutation', expected: pairs[0].actual, actual: negativeActual }])[0];
  assert.equal(control.changedPixels, 1, `Negative control must change exactly ONE screenshot pixel: ${JSON.stringify(control)}`);
  assert.equal(control.passed, false, 'Negative control incorrectly passed zero-pixel tolerance');
  if (options.update) {
    await mkdir(options.references, { recursive: true });
    for (const pair of pairs) await copyFile(pair.actual, pair.expected);
    manifest = { version: 1, width, height, frozenTime, fixtureHash, tolerance: { changedPixels: 0, channelDelta: 0 },
      browser: browserVersion, cases: fixtures.map(fixture => fixture.name) };
    await writeFile(path.join(options.references, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  const results = options.update ? [] : compare(pairs);
  const negativeReference = compare([{ name: 'mutated capture versus reference', expected: pairs[0].expected, actual: negativeActual }])[0];
  assert.equal(negativeReference.passed, false, 'Mutated screenshot must fail against the committed reference');
  const report = { mode: options.update ? 'update' : 'compare', browser: browserVersion, referenceBrowser: manifest.browser,
    tolerance: { changedPixels: 0, channelDelta: 0 }, captures: fixtures.map(fixture => fixture.name),
    runtimeRegression, negativeControl: control, negativeReference, results };
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${result.error || `${result.changedPixels} changed pixels`}`);
  console.log(`PASS negative control: one visible DOM pixel was rejected\nReport: ${path.join(outputDir, 'report.json')}`);
  if (results.some(result => !result.passed)) process.exitCode = 1;
  if (options.update) console.log('References captured. Review the actual PNGs and commit them with manifest.json; capture is not visual approval.');
} finally {
  if (cdp) cdp.socket.close();
  if (browser?.pid && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill('SIGTERM');
    const killTimer = setTimeout(() => browser.kill('SIGKILL'), 3000);
    await exited; clearTimeout(killTimer);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (profile) await rm(profile, { recursive: true, force: true });
}
