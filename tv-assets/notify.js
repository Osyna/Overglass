'use strict';
// On-screen toast, overlay card or spoken announcement, run by dispatch.sh.
//   node notify.js toast <base64 UTF-8 text>
//   node notify.js say <base64 UTF-8 text> [volume 1-40]
//   node notify.js overlay <file path>   (JSON widget tree written by dispatch.sh's read_upload; see tree())
// "say" must run under the TV lock /tmp/webos-foundry.lock (dispatch.sh wraps it in flock). TTS only speaks while the
// Audio Guidance setting is on and follows the TV-speaker volume, so it borrows Audio Guidance, volume
// and mute, and restores and re-reads all three. Success: JSON on stdout. Failure: message on stderr, exit 3.
const {spawn, spawnSync} = require('child_process');
const fs = require('fs');

const AU = 'luna://com.webos.service.audio/master/';
const ST = 'luna://com.webos.service.settings/';
const TTS = 'luna://com.webos.service.tts/';
const PW = 'luna://com.webos.service.tvpower/power/';
const MAX_CHARS = 200;
const OVERLAY_APP = 'dev.webosfoundry.overlay';
const CARD_KINDS = ['info', 'success', 'warning', 'alert'];
const TONES = [...CARD_KINDS, 'accent'];
const CARD_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'top', 'bottom', 'left', 'right'];
const CARD_SIZES = ['xs', 's', 'm', 'l', 'xl', 'full'];
const TEXT_SIZES = ['xs', 's', 'm', 'l', 'xl'];
const TEXT_WEIGHTS = ['normal', 'strong'];
const TEXT_COLORS = ['fg', 'fg-2', ...TONES];
const LIST_STYLES = ['bullet', 'number', 'plain'];
const WIDGET_TYPES = ['stack', 'row', 'text', 'image', 'badge', 'dot', 'progress', 'countdown', 'list', 'divider',
                      'compare', 'sparkline', 'section', 'event', 'stat', 'status', 'meta', 'clock'];
const IMAGE_SHAPES = ['square', 'circle'];
const IMAGE_SIZES = ['s', 'm', 'l'];
const ICONS = ['ball', 'bolt', 'chart', 'trophy', 'pulse', 'layers', 'clock', 'pin', 'sun', 'card', 'swap', 'target',
               'info', 'bell', 'star', 'flag'];
const STATES = ['online', 'offline', 'degraded', 'unknown'];
const CLOCK_FORMATS = ['time', 'seconds', 'date'];
const FONTS = ['sans', 'condensed', 'mono'];
const THEME_COLORS = ['accent', 'surface', 'text', 'muted', 'line'];
const MAX_TREE_DEPTH = 5;
const MAX_TREE_NODES = 80;
const MAX_REGIONS = 4;

function luna(uri, payload) {
  const r = spawnSync('luna-send', ['-n', '1', '-w', '3000', uri, JSON.stringify(payload)],
    {encoding: 'utf8', timeout: 3500, stdio: ['ignore', 'pipe', 'pipe']});
  if (r.error || r.status !== 0) throw new Error('TV service did not answer: ' + uri);
  let reply;
  try { reply = JSON.parse(r.stdout); } catch (e) { throw new Error('TV service returned malformed data: ' + uri); }
  if (reply.returnValue !== true) throw new Error(uri + ': ' + (reply.errorText || JSON.stringify(reply)));
  return reply;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function utf8(b64, maxBase64) {
  if (typeof b64 !== 'string' || b64.length > maxBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('Text must be base64');
  const text = Buffer.from(b64, 'base64').toString('utf8');
  if (text.includes('\ufffd')) throw new Error('Text must be UTF-8');
  return text;
}
function clean(text, max, what) {
  if (typeof text !== 'string' || [...text].length > max) throw new Error(what + ' must be text of at most ' + max + ' characters');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(what + ' must not contain control characters');
  return text.trim();
}
function decode(b64) {
  const text = clean(utf8(b64, 1200).trim(), MAX_CHARS, 'Text');
  if (!text) throw new Error('Text must be 1-' + MAX_CHARS + ' characters');
  return text;
}

function checkEnum(value, choices, what) {
  if (!choices.includes(value)) throw new Error(what + ' must be one of ' + choices.join(', '));
  return value;
}
function checkInt(value, lo, hi, what) {
  if (!Number.isInteger(value) || value < lo || value > hi) throw new Error(what + ' must be an integer ' + lo + '-' + hi);
  return value;
}

// One widget tree node (ARCHITECTURE.md section 3a), validated recursively. counter is a {n} box so the
// total-node cap applies across the whole tree, not one level.
function checkNode(node, depth, counter) {
  counter.n += 1;
  if (counter.n > MAX_TREE_NODES) throw new Error('A card may have at most ' + MAX_TREE_NODES + ' widgets');
  if (depth > MAX_TREE_DEPTH) throw new Error('A card may nest at most ' + MAX_TREE_DEPTH + ' levels deep');
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Each widget must be a JSON object');
  const kind = node.type;
  if (!WIDGET_TYPES.includes(kind)) throw new Error('Unknown widget type: ' + JSON.stringify(kind));
  const out = {type: kind};
  if (kind === 'stack' || kind === 'row') {
    const limit = kind === 'stack' ? 20 : 10;
    if (!Array.isArray(node.children) || node.children.length < 1 || node.children.length > limit) {
      throw new Error(kind + ' needs 1-' + limit + ' children');
    }
    if (node.gap !== undefined) out.gap = checkInt(node.gap, 0, 48, 'gap');
    if (node.align !== undefined) out.align = checkEnum(node.align, ['start', 'center', 'end'], 'align');
    out.children = node.children.map((child) => checkNode(child, depth + 1, counter));
  } else if (kind === 'text') {
    out.text = clean(node.text, 400, 'text');
    if (node.size !== undefined) out.size = checkEnum(node.size, TEXT_SIZES, 'size');
    if (node.weight !== undefined) out.weight = checkEnum(node.weight, TEXT_WEIGHTS, 'weight');
    if (node.color !== undefined) out.color = checkEnum(node.color, TEXT_COLORS, 'color');
  } else if (kind === 'image') {
    if (typeof node.src !== 'string' || node.src.length > 500 || !/^https?:\/\/[^\s"'<>]+$/.test(node.src)) {
      throw new Error('image src must be an http(s) URL of at most 500 characters');
    }
    out.src = node.src;
    if (node.shape !== undefined) out.shape = checkEnum(node.shape, IMAGE_SHAPES, 'shape');
    if (node.size !== undefined) out.size = checkEnum(node.size, IMAGE_SIZES, 'size');
  } else if (kind === 'badge') {
    out.text = clean(node.text, 24, 'badge text');
    optionalTone(node, out);
  } else if (kind === 'dot') {
    optionalTone(node, out);
  } else if (kind === 'progress') {
    out.value = checkFraction(node.value, 'progress value');
    if (node.label !== undefined) out.label = clean(node.label, 40, 'label');
    optionalTone(node, out);
  } else if (kind === 'countdown') {
    if (typeof node.target !== 'string' || Number.isNaN(Date.parse(node.target))) {
      throw new Error('countdown target must be an ISO 8601 datetime string');
    }
    out.target = node.target;
    if (node.label !== undefined) out.label = clean(node.label, 40, 'label');
  } else if (kind === 'list') {
    if (!Array.isArray(node.items) || node.items.length < 1 || node.items.length > 10) throw new Error('list needs 1-10 items');
    out.items = node.items.map((item) => clean(item, 120, 'Each item'));
    if (node.style !== undefined) out.style = checkEnum(node.style, LIST_STYLES, 'style');
  } else if (kind === 'compare') {
    if (!Array.isArray(node.segments) || node.segments.length < 2 || node.segments.length > 4) {
      throw new Error('compare needs 2-4 segments');
    }
    out.segments = node.segments.map(checkSegment);
  } else if (kind === 'sparkline') {
    if (!Array.isArray(node.points) || node.points.length < 3 || node.points.length > 24) {
      throw new Error('sparkline needs 3-24 points');
    }
    if (!node.points.every((p) => typeof p === 'number' && !Number.isNaN(p) && p >= -1 && p <= 1)) {
      throw new Error('sparkline points must be numbers between -1 and 1');
    }
    out.points = node.points.map(Number);
    if (node.axis !== undefined) {
      if (!Array.isArray(node.axis) || node.axis.length !== 3) throw new Error('sparkline axis must be three labels: top, middle, bottom');
      out.axis = node.axis.map((label) => clean(label, 6, 'axis label'));
    }
    optionalTone(node, out);
  } else if (kind === 'section') {
    out.title = clean(node.title, 40, 'section title');
    if (node.icon !== undefined) out.icon = checkEnum(node.icon, ICONS, 'icon');
    if (node.action !== undefined) out.action = clean(node.action, 24, 'section action');
  } else if (kind === 'event') {
    out.time = clean(node.time, 8, 'event time');
    out.text = clean(node.text, 120, 'event text');
    if (node.icon !== undefined) out.icon = checkEnum(node.icon, ICONS, 'icon');
    optionalTone(node, out);
  } else if (kind === 'stat') {
    out.label = clean(node.label, 40, 'stat label');
    out.left = clean(node.left, 16, 'stat left value');
    out.right = clean(node.right, 16, 'stat right value');
    out.fraction = checkFraction(node.fraction, 'stat fraction');
    optionalTone(node, out);
  } else if (kind === 'status') {
    out.label = clean(node.label, 40, 'status label');
    out.state = checkEnum(node.state, STATES, 'status state');
    if (node.detail !== undefined) out.detail = clean(node.detail, 24, 'status detail');
  } else if (kind === 'meta') {
    if (!Array.isArray(node.items) || node.items.length < 1 || node.items.length > 4) throw new Error('meta needs 1-4 items');
    out.items = node.items.map(checkMetaItem);
  } else if (kind === 'clock') {
    if (node.format !== undefined) out.format = checkEnum(node.format, CLOCK_FORMATS, 'clock format');
    if (node.label !== undefined) out.label = clean(node.label, 40, 'label');
  } // divider has no fields
  return out;
}

function optionalTone(node, out) {
  if (node.tone !== undefined) out.tone = checkEnum(node.tone, TONES, 'tone');
}
function checkFraction(value, what) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) throw new Error(what + ' must be a number 0-1');
  return value;
}
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkSegment(segment) {
  if (!isObject(segment)) throw new Error('Each compare segment must be a JSON object');
  const out = {label: clean(segment.label, 24, 'segment label'), value: clean(segment.value, 16, 'segment value'),
    fraction: checkFraction(segment.fraction, 'segment fraction')};
  optionalTone(segment, out);
  return out;
}

function checkMetaItem(item) {
  if (!isObject(item)) throw new Error('Each meta item must be a JSON object');
  const out = {label: clean(item.label, 24, 'meta label'), value: clean(item.value, 40, 'meta value')};
  if (item.icon !== undefined) out.icon = checkEnum(item.icon, ICONS, 'icon');
  return out;
}

function checkTheme(theme) {
  if (!isObject(theme)) throw new Error('theme must be a JSON object');
  const out = {};
  for (const [key, value] of Object.entries(theme)) {
    if (THEME_COLORS.includes(key)) {
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('theme ' + key + ' must be a #rrggbb colour');
      out[key] = value.toLowerCase();
    } else if (key === 'opacity') {
      if (typeof value !== 'number' || Number.isNaN(value) || value < 0.2 || value > 1) throw new Error('theme opacity must be a number 0.2-1');
      out[key] = value;
    } else if (key === 'radius') {
      out[key] = checkInt(value, 0, 32, 'theme radius');
    } else if (key === 'scale') {
      if (typeof value !== 'number' || Number.isNaN(value) || value < 0.75 || value > 1.5) throw new Error('theme scale must be a number 0.75-1.5');
      out[key] = value;
    } else if (key === 'font') {
      out[key] = checkEnum(value, FONTS, 'theme font');
    } else {
      throw new Error('Unknown theme field: ' + key);
    }
  }
  return out;
}

// By the time a card reaches here it is always {hide: true}, {position?, size?, seconds?, theme?, root: <tree>}
// or {seconds?, theme?, regions: [{position, size?, root}]}: the Python server already compiled
// title/body/lines/image/kind into a tree before this crossed SSH. Re-checked here (shape only, not
// re-compiled) because the dispatcher only validates size, not structure -- defence in depth against a
// crafted SSH command, same as every other verb.
function tree(filePath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { throw new Error('Overlay card must be JSON'); }
  if (!isObject(raw)) throw new Error('Overlay card must be a JSON object');
  if (raw.hide !== undefined) {
    if (raw.hide !== true || Object.keys(raw).length !== 1) throw new Error('Use {"hide": true} alone to hide the overlay');
    return {hide: true};
  }
  const allowed = raw.regions !== undefined ? ['seconds', 'theme', 'regions'] : ['position', 'size', 'seconds', 'theme', 'root'];
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error('Unknown overlay field: ' + extra.join(', '));
  const out = {};
  if (raw.seconds !== undefined) out.seconds = checkInt(raw.seconds, 0, 300, 'seconds');
  if (raw.theme !== undefined) out.theme = checkTheme(raw.theme);
  const counter = {n: 0};
  if (raw.regions !== undefined) {
    if (!Array.isArray(raw.regions) || raw.regions.length < 1 || raw.regions.length > MAX_REGIONS) {
      throw new Error('regions needs 1-' + MAX_REGIONS + ' entries');
    }
    const seen = new Set();
    out.regions = raw.regions.map((region) => {
      if (!isObject(region) || region.root === undefined || Object.keys(region).some((k) => !['position', 'size', 'root'].includes(k))) {
        throw new Error('Each region is {"position", "size"?, "root"}');
      }
      const checked = {position: checkEnum(region.position, CARD_POSITIONS, 'region position')};
      if (seen.has(checked.position)) throw new Error('Each region needs a different position');
      seen.add(checked.position);
      if (region.size !== undefined) checked.size = checkEnum(region.size, CARD_SIZES, 'size');
      checked.root = checkNode(region.root, 0, counter);
      return checked;
    });
    return out;
  }
  if (raw.root === undefined) throw new Error('A card needs a root widget tree');
  if (raw.position !== undefined) out.position = checkEnum(raw.position, CARD_POSITIONS, 'position');
  if (raw.size !== undefined) out.size = checkEnum(raw.size, CARD_SIZES, 'size');
  out.root = checkNode(raw.root, 0, counter);
  return out;
}

function requireOn() {
  const power = luna(PW + 'getPowerState', {}).state;
  if (power !== 'Active' && power !== 'Screen Saver') throw new Error('The TV is not on (' + power + ')');
}

// Launching an app in standby could light the panel, so cards are only sent to a TV that is on.
// The app's window takes key focus: a button press while a card is up dismisses it and does not reach the input.
function overlay(params) {
  requireOn();
  luna('luna://com.webos.applicationManager/launch', {id: OVERLAY_APP, params});
  return {returnValue: true, overlay: params.hide ? 'hidden' : 'shown'};
}

// After Audio Guidance is switched on, the TTS service answers "Service is not ready" for a moment.
async function ttsReady(ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    try {
      if ((luna(TTS + 'getStatus', {}).status || {}).infoAudioGuidanceStatus === 1) return;
    } catch (e) { /* still starting */ }
  }
  throw new Error('TTS did not become ready within ' + ms / 1000 + ' s');
}

function volumeStatus() {
  const v = luna(AU + 'getVolume', {}).volumeStatus;
  if (!v || !Number.isInteger(v.volume) || typeof v.muteStatus !== 'boolean') throw new Error('TV returned malformed volume status');
  if (v.soundOutput !== 'tv_speaker') throw new Error('Announcements need TV-speaker output; current output is ' + v.soundOutput);
  return v;
}
const guidance = () => luna(ST + 'getSystemSettings', {category: 'option', keys: ['audioGuidance']}).settings.audioGuidance;
const setGuidance = (value) => luna(ST + 'setSystemSettings', {category: 'option', settings: {audioGuidance: value}});

// Resolves when the subscribed speak reports done; rejects on error or timeout.
function speak(text, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn('luna-send', ['-i', TTS + 'speak', JSON.stringify({text, clear: true, subscribe: true})],
      {stdio: ['ignore', 'pipe', 'pipe']});
    let buffer = '';
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('TTS did not finish within ' + ms / 1000 + ' s')), ms);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let line;
      while ((line = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, line).trim();
        buffer = buffer.slice(line + 1);
        if (!text.startsWith('{')) continue;
        let reply;
        try { reply = JSON.parse(text); } catch (e) { continue; }
        if (reply.returnValue === false) finish(new Error('TTS refused: ' + (reply.errorText || JSON.stringify(reply))));
        else if (reply.msgStatus === 'done') finish();
      }
    });
    child.on('exit', () => finish(new Error('TTS stopped without finishing')));
  });
}

async function say(text, volume) {
  requireOn();
  const before = volumeStatus();
  const guidanceBefore = guidance();
  if (guidanceBefore !== 'on' && guidanceBefore !== 'off') throw new Error('TV returned unexpected Audio Guidance value');
  let failure = null;
  try {
    if (guidanceBefore !== 'on') setGuidance('on');
    luna(AU + 'setVolume', {soundOutput: 'tv_speaker', volume});
    if (volumeStatus().muteStatus) luna(AU + 'muteVolume', {soundOutput: 'tv_speaker', mute: false});
    await ttsReady(5000);
    await speak(text, 30000);
  } catch (error) {
    failure = error;
  }
  // Restore in this order: setVolume can clear mute, so mute goes last. Every step runs even if one fails.
  const restoreErrors = [];
  for (const step of [
    () => guidanceBefore !== 'on' && setGuidance(guidanceBefore),
    () => luna(AU + 'setVolume', {soundOutput: 'tv_speaker', volume: before.volume}),
    () => luna(AU + 'muteVolume', {soundOutput: 'tv_speaker', mute: before.muteStatus}),
  ]) {
    try { step(); } catch (error) { restoreErrors.push(error.message); }
  }
  const after = volumeStatus();
  if (guidance() !== guidanceBefore || after.volume !== before.volume || after.muteStatus !== before.muteStatus) {
    restoreErrors.push('readback after restore differs: volume ' + after.volume + ', muted ' + after.muteStatus);
  }
  if (restoreErrors.length) throw new Error('Could not restore the TV: ' + restoreErrors.join('; '));
  if (failure) throw failure;
  return {returnValue: true, spoke: [...text].length, volume};
}

function toast(text) {
  const r = luna('luna://com.webos.notification/createToast', {message: text, persistent: false, noaction: true});
  return {returnValue: true, toastId: r.toastId};
}

async function main(argv) {
  const [mode, arg, volumeArg] = argv;
  if (mode === 'toast' && argv.length === 2) return toast(decode(arg));
  if (mode === 'overlay' && argv.length === 2) return overlay(tree(arg));
  if (mode === 'say' && (argv.length === 2 || argv.length === 3)) {
    const volume = argv.length === 3 ? Number(volumeArg) : 15;
    if (!Number.isInteger(volume) || volume < 1 || volume > 40) throw new Error('Volume must be an integer 1-40');
    return say(decode(arg), volume);
  }
  throw new Error('Usage: toast <base64> | say <base64> [volume 1-40] | overlay <file path>');
}

if (process.argv[2] === '--selftest') {
  const assert = require('assert');
  const b = (s) => Buffer.from(s, 'utf8').toString('base64');
  assert.strictEqual(decode(b('  Dîner prêt  ')), 'Dîner prêt');
  for (const bad of ['', 'not base64!', b(''), b('a\nb'), b('x'.repeat(201)), Buffer.from([0xff, 0xfe]).toString('base64')]) {
    assert.throws(() => decode(bad), bad);
  }
  const os = require('os');
  const path = require('path');
  let fileN = 0;
  const writeFile = (obj) => {
    const p = path.join(os.tmpdir(), 'notify-selftest-' + process.pid + '-' + (fileN++) + '.json');
    fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return p;
  };
  const treeOf = (obj) => {
    const p = writeFile(obj);
    try { return tree(p); } finally { fs.unlinkSync(p); }
  };
  const simpleCard = {position: 'top-right', seconds: 0, root: {type: 'stack', gap: 12, children: [
    {type: 'row', gap: 14, align: 'center', children: [{type: 'dot', tone: 'alert'}, {type: 'text', text: 'Door', size: 'l', weight: 'strong'}]},
    {type: 'list', items: ['a']},
  ]}};
  assert.deepStrictEqual(treeOf(simpleCard), simpleCard);
  const v3Card = {root: {type: 'stack', children: [
    {type: 'image', src: 'https://example.com/crest.png', shape: 'circle'},
    {type: 'compare', segments: [{label: 'SRB', value: '51%', fraction: 0.51, tone: 'success'},
                                 {label: 'AND', value: '19%', fraction: 0.19}]},
    {type: 'sparkline', points: [-0.2, 0.1, 0.3], tone: 'info'},
  ]}};
  assert.deepStrictEqual(treeOf(v3Card), v3Card);
  const v4Card = {seconds: 0, theme: {accent: '#c8f542', surface: '#0b0d10', opacity: 0.92, radius: 0, scale: 1.1, font: 'condensed'},
    regions: [
      {position: 'top', size: 'full', root: {type: 'row', gap: 24, children: [
        {type: 'image', src: 'https://example.com/a.png', shape: 'circle', size: 's'},
        {type: 'text', text: '0 - 0', size: 'xl', weight: 'strong', color: 'accent'},
        {type: 'clock', format: 'time', label: '1st half'}, {type: 'badge', text: 'LIVE', tone: 'accent'}]}},
      {position: 'right', size: 's', root: {type: 'stack', children: [
        {type: 'section', title: 'Live events', icon: 'bolt', action: 'All events'},
        {type: 'event', time: '08:17', text: 'Yellow card', icon: 'card', tone: 'warning'},
        {type: 'stat', label: 'Possession', left: '62%', right: '38%', fraction: 0.62},
        {type: 'sparkline', points: [0.2, -0.1, 0.4], axis: ['+0.4', '0.0', '-0.4']},
        {type: 'meta', items: [{label: 'Venue', value: 'Somewhere', icon: 'pin'}]},
        {type: 'status', label: 'Match Data API', state: 'online', detail: '112 ms'}]}}]};
  assert.deepStrictEqual(treeOf(v4Card), v4Card);
  assert.deepStrictEqual(treeOf({theme: {accent: '#ABCDEF'}, root: {type: 'text', text: 'x'}}).theme, {accent: '#abcdef'});
  assert.deepStrictEqual(treeOf({hide: true}), {hide: true});
  for (const bad of [{}, {hide: true, root: {type: 'text', text: 'x'}}, {root: {type: 'text', text: 'x'}, extra: 1},
    {root: {type: 'text', text: 'x'.repeat(401)}}, {root: {type: 'text', text: 'a\u0007'}},
    {root: {type: 'stack', children: []}}, {root: {type: 'stack', children: Array(21).fill({type: 'text', text: 'x'})}},
    {root: {type: 'image', src: 'file:///etc/passwd'}}, {root: {type: 'image', src: 'javascript:alert(1)'}},
    {root: {type: 'badge', text: 'x', tone: 'red'}}, {seconds: 1.5, root: {type: 'text', text: 'x'}},
    {seconds: 301, root: {type: 'text', text: 'x'}}, {root: {type: 'nope'}}, {root: [1]},
    {root: {type: 'progress', value: 1.5}}, {root: {type: 'countdown', target: 'not a date'}},
    {root: {type: 'image', src: 'https://x/a.png', shape: 'round'}}, {root: {type: 'image', src: 'https://x/a.png', size: 'xl'}},
    {root: {type: 'compare', segments: []}}, {root: {type: 'compare', segments: [{label: 'a', value: '1', fraction: 1.5}, {label: 'b', value: '2', fraction: 0.5}]}},
    {root: {type: 'sparkline', points: [0.1, 0.2]}}, {root: {type: 'sparkline', points: [2, 0.1, 0.2]}},
    {root: {type: 'sparkline', points: [0, 0.5, 1], axis: ['a', 'b']}},
    {theme: {accent: 'lime'}, root: {type: 'text', text: 'x'}}, {theme: {opacity: 0.1}, root: {type: 'text', text: 'x'}},
    {theme: {radius: 40}, root: {type: 'text', text: 'x'}}, {theme: {scale: 2}, root: {type: 'text', text: 'x'}},
    {theme: {font: 'comic'}, root: {type: 'text', text: 'x'}}, {theme: {glow: true}, root: {type: 'text', text: 'x'}},
    {regions: []}, {regions: [{root: {type: 'text', text: 'x'}}]}, {regions: [{position: 'top', root: {type: 'text', text: 'x'}}], position: 'top'},
    {regions: [{position: 'top', root: {type: 'text', text: 'x'}}, {position: 'top', root: {type: 'text', text: 'y'}}]},
    {regions: Array(5).fill({position: 'top', root: {type: 'text', text: 'x'}})},
    {regions: [{position: 'top', root: {type: 'text', text: 'x'}}, {position: 'right', root: {type: 'row', children: Array(8).fill({type: 'row', children: Array(10).fill({type: 'text', text: 'x'})})}}]},
    {root: {type: 'section', title: 'x', icon: 'wand'}}, {root: {type: 'event', text: 'x'}}, {root: {type: 'event', time: '1', text: 'x', tone: 'pink'}},
    {root: {type: 'stat', label: 'a', left: '1', right: '2', fraction: 1.2}}, {root: {type: 'status', label: 'api', state: 'up'}},
    {root: {type: 'meta', items: []}}, {root: {type: 'meta', items: [{label: 'a', value: 'b', icon: 'nope'}]}}, {root: {type: 'clock', format: 'stardate'}},
    {root: {type: 'stack', children: [{type: 'stack', children: [{type: 'stack', children: [{type: 'stack', children: [{type: 'stack', children: [{type: 'stack', children: [{type: 'text', text: 'x'}]}]}]}]}]}]}}]) {
    assert.throws(() => treeOf(bad), JSON.stringify(bad));
  }
  assert.throws(() => treeOf('not json'));
  console.log('notify selftest ok');
} else {
  main(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => { console.error(error.message); process.exit(3); });
}
