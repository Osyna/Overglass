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
                      'compare', 'sparkline', 'section', 'event', 'stat', 'status', 'meta', 'clock', 'grid', 'ticker', 'qr', 'svg'];
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
const MAX_TREE_BYTES = 49152;
const bad = (message) => new Error(message);

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

function strictFields(value, allowed, what) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw bad('Unknown ' + what + ' field: ' + unknown.join(', '));
}

function checkSvg(source) {
  const fail = () => { throw bad('SVG must be a safe inline geometry document of at most 8192 characters'); };
  if (typeof source !== 'string' || source.length > 8192 || /[^\x20-\x7e]|&|<!|<\?/.test(source)) fail();
  source = source.replace(/^ +| +$/g, '');
  const tags = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
  const scalars = ['width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'stroke-width'];
  const scalar = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:%|px)?$/;
  const paint = /^(?:none|currentColor|transparent|black|white|red|green|blue|yellow|gray|grey|#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)$/;
  const stack = [];
  let rootSeen = false;
  let pos = 0;
  while (pos < source.length) {
    if (source[pos] === ' ') { pos += 1; continue; }
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)([^<>]*?)(\/?)>/.exec(source.slice(pos));
    if (!tag || !tags.includes(tag[2])) fail();
    const name = tag[2];
    if (tag[1]) {
      if (tag[4] || !/^ *$/.test(tag[3]) || stack.pop() !== name) fail();
    } else {
      if (!stack.length) {
        if (rootSeen || name !== 'svg') fail();
        rootSeen = true;
      } else if (name === 'svg') fail();
      let attrs = tag[3];
      const seen = new Set();
      while (attrs && !/^ *$/.test(attrs)) {
        const attr = /^ +([A-Za-z][A-Za-z0-9-]*) *= *(["'])(.*?)\2/.exec(attrs);
        if (!attr || seen.has(attr[1])) fail();
        const key = attr[1], value = attr[3];
        seen.add(key);
        let valid = false;
        if (key === 'xmlns') valid = !stack.length && value === 'http://www.w3.org/2000/svg';
        else if (scalars.includes(key)) valid = scalar.test(value);
        else if (key === 'fill' || key === 'stroke') valid = paint.test(value);
        else if (['opacity', 'fill-opacity', 'stroke-opacity'].includes(key)) {
          valid = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value) && Number(value) >= 0 && Number(value) <= 1;
        } else if (key === 'viewBox' || key === 'points') valid = /^[-+0-9.eE, ]+$/.test(value);
        else if (key === 'd') valid = /^[MmZzLlHhVvCcSsQqTtAa0-9eE+., -]+$/.test(value);
        else if (key === 'transform') valid = /^(?: *(?:matrix|translate|scale|rotate|skewX|skewY)\( *[-+0-9.eE, ]+\) *)+$/.test(value);
        else if (key === 'fill-rule') valid = ['nonzero', 'evenodd'].includes(value);
        else if (key === 'stroke-linecap') valid = ['butt', 'round', 'square'].includes(value);
        else if (key === 'stroke-linejoin') valid = ['miter', 'round', 'bevel'].includes(value);
        if (!valid) fail();
        attrs = attrs.slice(attr[0].length);
      }
      if (!tag[4]) stack.push(name);
    }
    pos += tag[0].length;
  }
  if (!rootSeen || stack.length) fail();
  return source;
}

function checkCardOptions(raw, out) {
  if ('animation' in raw) {
    if (!isObject(raw.animation)) throw bad('animation must be a JSON object');
    strictFields(raw.animation, ['enter', 'exit', 'duration_ms'], 'animation');
    out.animation = {};
    for (const key of ['enter', 'exit']) {
      if (key in raw.animation) out.animation[key] = checkEnum(raw.animation[key], ['none', 'fade', 'slide', 'wipe'], key);
    }
    if ('duration_ms' in raw.animation) out.animation.duration_ms = checkInt(raw.animation.duration_ms, 0, 2000, 'duration_ms');
  }
  if ('offset' in raw) {
    if (!isObject(raw.offset)) throw bad('offset must be a JSON object');
    strictFields(raw.offset, ['x', 'y'], 'offset');
    out.offset = {};
    if ('x' in raw.offset) out.offset.x = checkInt(raw.offset.x, -1920, 1920, 'offset x');
    if ('y' in raw.offset) out.offset.y = checkInt(raw.offset.y, -1080, 1080, 'offset y');
  }
  if ('behavior' in raw) {
    if (!isObject(raw.behavior)) throw bad('behavior must be a JSON object');
    strictFields(raw.behavior, ['on_foreground', 'ambient_dim'], 'behavior');
    out.behavior = {};
    if ('on_foreground' in raw.behavior) out.behavior.on_foreground = checkEnum(raw.behavior.on_foreground, ['keep', 'hide', 'shrink'], 'on_foreground');
    if ('ambient_dim' in raw.behavior) {
      if (typeof raw.behavior.ambient_dim !== 'boolean') throw bad('ambient_dim must be a boolean');
      out.behavior.ambient_dim = raw.behavior.ambient_dim;
    }
  }
  if ('dim' in raw) {
    if (typeof raw.dim !== 'number' || !Number.isFinite(raw.dim) || raw.dim < 0.2 || raw.dim > 1) throw bad('dim must be a number 0.2-1');
    out.dim = raw.dim;
  }
  if ('compact' in raw) {
    if (typeof raw.compact !== 'boolean') throw bad('compact must be a boolean');
    out.compact = raw.compact;
  }
}

function checkRuntime(raw) {
  if (raw.action === 'state') {
    strictFields(raw, ['action'], 'overlay state');
    return {action: 'state'};
  }
  strictFields(raw, ['action', 'dim', 'compact', 'hidden'], 'runtime');
  if (raw.action !== 'runtime') throw bad('Unknown overlay action');
  const out = {action: 'runtime'};
  checkCardOptions(raw, out);
  if ('hidden' in raw) {
    if (typeof raw.hidden !== 'boolean') throw bad('hidden must be a boolean');
    out.hidden = raw.hidden;
  }
  return out;
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
  if (kind === 'stack' || kind === 'row' || kind === 'grid') {
    const limit = kind === 'row' ? 10 : 20;
    if (!Array.isArray(node.children) || node.children.length < 1 || node.children.length > limit) {
      throw new Error(kind + ' needs 1-' + limit + ' children');
    }
    if (node.gap !== undefined) out.gap = checkInt(node.gap, 0, 48, 'gap');
    if (kind === 'grid') out.columns = checkInt(node.columns, 1, 3, 'columns');
    else if (node.align !== undefined) out.align = checkEnum(node.align, ['start', 'center', 'end'], 'align');
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
  if (kind === 'ticker' || kind === 'qr') {
    out.text = clean(node.text, 1000, kind + ' text');
    if (!out.text) throw new Error(kind + ' text must not be empty');
    if (kind === 'ticker') {
      if (node.speed !== undefined) out.speed = checkInt(node.speed, 10, 200, 'ticker speed');
      optionalTone(node, out);
    } else {
      if (Buffer.byteLength(out.text, 'utf8') > 2953) throw bad('QR text exceeds 2953 UTF-8 bytes');
      try { encodeURIComponent(out.text); } catch (e) { throw bad('QR text must be valid Unicode'); }
      if (node.size !== undefined) out.size = checkEnum(node.size, IMAGE_SIZES, 'size');
    }
  } else if (kind === 'svg') {
    out.source = checkSvg(node.source);
    if (node.size !== undefined) out.size = checkEnum(node.size, IMAGE_SIZES, 'size');
  }
  strictFields(node, Object.keys(out), kind);
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
  strictFields(segment, Object.keys(out), 'compare segment');
  return out;
}

function checkMetaItem(item) {
  if (!isObject(item)) throw new Error('Each meta item must be a JSON object');
  const out = {label: clean(item.label, 24, 'meta label'), value: clean(item.value, 40, 'meta value')};
  if (item.icon !== undefined) out.icon = checkEnum(item.icon, ICONS, 'icon');
  strictFields(item, Object.keys(out), 'meta item');
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

function checkNormalCard(raw, counter, allowTimeline) {
  if (!isObject(raw)) throw bad('Overlay card must be a JSON object');
  const out = {};
  const common = ['seconds', 'theme', 'behavior', 'dim', 'compact'];
  if ('seconds' in raw) out.seconds = checkInt(raw.seconds, 0, 300, 'seconds');
  if ('theme' in raw) out.theme = checkTheme(raw.theme);
  checkCardOptions(raw, out);
  if ('timeline' in raw) {
    if (!allowTimeline) throw bad('Nested timelines are not allowed');
    strictFields(raw, common.concat('timeline'), 'overlay');
    if (!Array.isArray(raw.timeline) || raw.timeline.length < 1 || raw.timeline.length > 4) throw bad('timeline needs 1-4 frames');
    out.timeline = raw.timeline.map((frame) => {
      if (!isObject(frame)) throw bad('Each timeline frame must be a JSON object');
      strictFields(frame, ['seconds', 'card'], 'timeline frame');
      return {seconds: checkInt(frame.seconds, 1, 300, 'frame seconds'), card: checkNormalCard(frame.card, counter, false)};
    });
  } else if ('regions' in raw) {
    strictFields(raw, common.concat('regions'), 'overlay');
    if (!Array.isArray(raw.regions) || raw.regions.length < 1 || raw.regions.length > MAX_REGIONS) throw bad('regions needs 1-' + MAX_REGIONS + ' entries');
    const seen = new Set();
    out.regions = raw.regions.map((region) => {
      if (!isObject(region)) throw bad('Each region must be a JSON object');
      strictFields(region, ['position', 'size', 'root', 'animation', 'offset', 'behavior', 'dim', 'compact'], 'region');
      const checked = {position: checkEnum(region.position, CARD_POSITIONS, 'region position')};
      if (seen.has(checked.position)) throw bad('Each region needs a different position');
      seen.add(checked.position);
      if ('size' in region) checked.size = checkEnum(region.size, CARD_SIZES, 'size');
      checkCardOptions(region, checked);
      checked.root = checkNode(region.root, 0, counter);
      return checked;
    });
  } else {
    const single = common.concat(['position', 'size', 'animation', 'offset']);
    if ('position' in raw) out.position = checkEnum(raw.position, CARD_POSITIONS, 'position');
    if ('size' in raw) out.size = checkEnum(raw.size, CARD_SIZES, 'size');
    if ('root' in raw) {
      strictFields(raw, single.concat('root'), 'overlay');
      out.root = checkNode(raw.root, 0, counter);
    } else {
      throw bad('A card needs a root widget tree');
    }
  }
  return out;
}

function checkOverlayRequest(raw) {
  if (!isObject(raw)) throw bad('Overlay card must be a JSON object');
  if ('hide' in raw) {
    if (raw.hide !== true || Object.keys(raw).length !== 1) throw bad('Use {"hide": true} alone to hide the overlay');
    return {hide: true};
  }
  const out = 'action' in raw ? checkRuntime(raw) : checkNormalCard(raw, {n: 0}, true);
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_TREE_BYTES) throw bad('Card is too large (at most ' + MAX_TREE_BYTES + ' bytes of JSON)');
  return out;
}

// SSH input is already compiled; only the HTTP entry point accepts shorthand.
function tree(filePath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { throw bad('Overlay card must be JSON'); }
  return checkOverlayRequest(raw);
}

function requireOn() {
  const power = luna(PW + 'getPowerState', {}).state;
  if (power !== 'Active' && power !== 'Screen Saver') throw new Error('The TV is not on (' + power + ')');
}

// Launching an app in standby could light the panel, so cards are only sent to a TV that is on.
// The app's window takes key focus: a button press while a card is up dismisses it and does not reach the input.
function overlay(params) {
  if (params.action === 'state' || params.action === 'runtime') {
    const apps = luna('luna://com.webos.applicationManager/running', {}).running;
    if (!Array.isArray(apps)) throw new Error('TV returned malformed running applications');
    const running = apps.some((app) => isObject(app) && app.id === OVERLAY_APP);
    if (params.action === 'state' || !running) return {returnValue: true, running, overlay: running ? 'shown' : 'hidden'};
  }
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
  const textNode = {type: 'text', text: 'x'};
  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="translate(1,2) scale(.5)" opacity="0.5"><path d="M0 0L12 12Z" fill="#abc" fill-rule="evenodd"/><rect x="1" y="2" width="10px" height="50%" rx="1" ry="2" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="bevel" fill-opacity="0" stroke-opacity="1"/><circle cx="2" cy="3" r="1"/><ellipse cx="2" cy="3" rx="1" ry="2"/><line x1="0" y1="0" x2="1" y2="1"/><polyline points="0,0 1,1"/><polygon points="0,0 1,1 2,0"/></g></svg>';
  const unsafeSvg = ['', '<g/>', '<svg/><svg/>', '<svg><svg/></svg>', '<svg><g></svg>', '<svg>', '<svg></svg>oops',
    '<svg><script/></svg>', '<svg><foreignObject/></svg>', '<svg><use href="#x"/></svg>', '<svg><image/></svg>',
    '<svg onload="alert(1)"/>', '<svg style="fill:red"/>', '<svg fill="url(https://evil)"/>', '<svg fill="url(#x)"/>',
    '<svg xmlns="https://evil"/>', '<svg><g xmlns="http://www.w3.org/2000/svg"/></svg>', '<svg xmlns:x="x"/>',
    '<svg width="1" width="2"/>', '<svg width=1/>', '<svg width="1"height="1"/>', '<svg width="NaN"/>',
    '<svg opacity="1.1"/>', '<svg opacity="50%"/>', '<svg transform="url(x)"/>', '<svg><text>hello</text></svg>',
    '<svg>&amp;</svg>', '<svg>&#x41;</svg>', '<!DOCTYPE svg><svg/>', '<?xml version="1.0"?><svg/>',
    '<svg><!-- comment --></svg>', '<svg><![CDATA[x]]></svg>', '<svg>\n</svg>', '<svg>é</svg>', '<svg/></svg>', '<svg / >'];
  const widgetCard = {animation: {enter: 'slide', exit: 'wipe', duration_ms: 2000}, offset: {x: -1920, y: 1080},
    behavior: {on_foreground: 'shrink', ambient_dim: true}, dim: 0.2, compact: false,
    root: {type: 'grid', columns: 3, gap: 48, children: [
      {type: 'ticker', text: 'News', speed: 200, tone: 'accent'}, {type: 'qr', text: 'https://example.com', size: 's'},
      {type: 'svg', source: safeSvg, size: 'l'}]}};
  assert.deepStrictEqual(treeOf(widgetCard), widgetCard);
  for (const effect of ['none', 'fade', 'slide', 'wipe']) {
    const card = {root: textNode, animation: {enter: effect, exit: effect, duration_ms: 0}};
    assert.deepStrictEqual(treeOf(card), card);
  }
  for (const on_foreground of ['keep', 'hide', 'shrink']) {
    const card = {root: textNode, behavior: {on_foreground, ambient_dim: false}, offset: {x: 1920, y: -1080}, dim: 1, compact: true};
    assert.deepStrictEqual(treeOf(card), card);
  }
  const sparseOptions = {root: textNode, animation: {}, offset: {}, behavior: {}};
  assert.deepStrictEqual(treeOf(sparseOptions), sparseOptions);
  for (const size of ['s', 'm', 'l']) for (const type of ['qr', 'svg']) {
    const card = {root: type === 'qr' ? {type, text: 'hello', size} : {type, source: safeSvg, size}};
    assert.deepStrictEqual(treeOf(card), card);
  }
  assert.strictEqual(treeOf({root: {type: 'svg', source: '  <svg/>  '}}).root.source, '<svg/>');
  assert.strictEqual(treeOf({root: {type: 'svg', source: '<svg>' + ' '.repeat(8181) + '</svg>'}}).root.source.length, 8192);
  assert.deepStrictEqual(treeOf({root: {type: 'ticker', text: 'x'.repeat(1000), speed: 10}}).root.text, 'x'.repeat(1000));
  assert.strictEqual(treeOf({root: {type: 'qr', text: 'é'.repeat(976) + 'a'.repeat(24)}}).root.text.length, 1000);
  assert.strictEqual(treeOf({root: {type: 'qr', text: '界'.repeat(984) + 'a'}}).root.text.length, 985);
  const regionCard = {behavior: {ambient_dim: true}, dim: 0.5, compact: true,
    regions: ['top', 'right', 'bottom', 'left'].map((position) => ({position, ...widgetCard}))};
  assert.deepStrictEqual(treeOf(regionCard), regionCard);
  const timeline = {seconds: 0, theme: {font: 'mono'}, behavior: {on_foreground: 'hide'},
    timeline: [{seconds: 1, card: widgetCard}, {seconds: 300, card: regionCard}]};
  assert.deepStrictEqual(treeOf(timeline), timeline);
  const eightyNodes = {timeline: Array.from({length: 4}, () => ({seconds: 1,
    card: {root: {type: 'stack', children: Array(19).fill(textNode)}}}))};
  assert.deepStrictEqual(treeOf(eightyNodes), eightyNodes);
  const eightyOne = JSON.parse(JSON.stringify(eightyNodes));
  eightyOne.timeline[3].card.root.children.push(textNode);
  let depthFive = textNode;
  for (let i = 0; i < 5; i += 1) depthFive = {type: 'grid', columns: 1, gap: 0, children: [depthFive]};
  assert.deepStrictEqual(treeOf({root: depthFive}), {root: depthFive});
  for (const runtime of [{action: 'runtime'}, {action: 'runtime', dim: 0.2, compact: true, hidden: true},
    {action: 'runtime', dim: 1, compact: false, hidden: false}]) assert.deepStrictEqual(treeOf(runtime), runtime);
  const invalidCards = [eightyOne, {root: {type: 'stack', children: [depthFive]}},
    {root: {type: 'grid', columns: 0, children: [textNode]}}, {root: {type: 'grid', columns: 4, children: [textNode]}},
    {root: {type: 'grid', columns: 1.5, children: [textNode]}}, {root: {type: 'grid', columns: true, children: [textNode]}},
    {root: {type: 'grid', columns: 1, gap: 49, children: [textNode]}}, {root: {type: 'grid', columns: 1, gap: -1, children: [textNode]}},
    {root: {type: 'grid', columns: 1, align: 'start', children: [textNode]}}, {root: {type: 'grid', columns: 1, children: []}},
    {root: {type: 'grid', columns: 1, children: Array(21).fill(textNode)}},
    ...['ticker', 'qr'].flatMap((type) => ['', ' ', 'x'.repeat(1001), 'a\nb'].map((text) => ({root: {type, text}}))),
    ...[9, 201, 10.5, true].map((speed) => ({root: {type: 'ticker', text: 'x', speed}})),
    {root: {type: 'ticker', text: 'x', tone: 'red'}}, {root: {type: 'qr', text: 'x', size: 'xl'}},
    {root: {type: 'qr', text: '界'.repeat(985)}}, {root: {type: 'qr', text: '\ud800'}},
    {root: {type: 'svg', source: safeSvg, size: 'xl'}}, {root: {type: 'svg', source: '<svg>' + ' '.repeat(8182) + '</svg>'}},
    ...unsafeSvg.map((source) => ({root: {type: 'svg', source}})),
    ...[{enter: 'zoom'}, {exit: 'zoom'}, {duration_ms: -1}, {duration_ms: 2001}, {duration_ms: 0.5}, {duration_ms: true}, {extra: 1}, null].map((animation) => ({root: textNode, animation})),
    ...[{x: -1921}, {x: 1921}, {y: -1081}, {y: 1081}, {x: 0.5}, {x: true}, {z: 0}, null].map((offset) => ({root: textNode, offset})),
    ...[{on_foreground: 'close'}, {ambient_dim: 1}, {extra: true}, null].map((behavior) => ({root: textNode, behavior})),
    ...[0.19, 1.01, '1', true, null].map((dim) => ({root: textNode, dim})), {root: textNode, compact: 1},
    {root: {...textNode, extra: true}}, {root: {type: 'dot', constructor: 'bad'}},
    {root: {type: 'compare', segments: [{label: 'a', value: '1', fraction: 0, extra: 1}, {label: 'b', value: '2', fraction: 1}]}},
    {root: {type: 'meta', items: [{label: 'a', value: 'b', extra: 1}]}},
    {timeline: []}, {timeline: Array(5).fill({seconds: 1, card: {root: textNode}})},
    ...[0, 301, 1.5, true].map((seconds) => ({timeline: [{seconds, card: {root: textNode}}]})),
    ...[{hide: true}, {action: 'runtime'}, {timeline: [{seconds: 1, card: {root: textNode}}]}].map((card) => ({timeline: [{seconds: 1, card}]})),
    {timeline: [{seconds: 1, card: {root: textNode}, extra: 1}]}, {timeline: [{seconds: 1, card: {root: textNode}}], root: textNode},
    {timeline: [{seconds: 1, card: {root: textNode}}], regions: []}, {timeline: [{seconds: 1, card: {root: textNode}}], animation: {}},
    {regions: [{position: 'top', root: textNode}], offset: {}}, {action: 'runtime', root: textNode},
    {action: 'runtime', dim: 0.1}, {action: 'runtime', compact: 1}, {action: 'runtime', hidden: 1},
    {action: 'runtime', behavior: {}}, {action: 'other'}, {hide: false}, {hide: true, action: 'runtime'}];
  for (const card of invalidCards) assert.throws(() => treeOf(card), JSON.stringify(card));
  const oversized = {root: {type: 'grid', columns: 3, children: Array(6).fill({type: 'svg', source: '<svg>' + ' '.repeat(8181) + '</svg>'})}};
  assert.throws(() => treeOf(oversized), /too large/);
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
  assert.deepStrictEqual(treeOf({action: 'state'}), {action: 'state'});
  assert.throws(() => treeOf({action: 'state', dim: 0.5}));
  const originalLuna = luna, lifecycleCalls = [];
  let runningOverlay = false;
  luna = (uri, payload) => {
    lifecycleCalls.push(uri);
    if (uri.endsWith('/running')) return {running: runningOverlay ? [{id: OVERLAY_APP}] : []};
    if (uri.endsWith('/getPowerState')) return {state: 'Active'};
    if (uri.endsWith('/launch')) return {returnValue: true};
    throw new Error('Unexpected lifecycle service call: ' + uri);
  };
  try {
    assert.strictEqual(overlay({action: 'state'}).running, false);
    assert.strictEqual(overlay({action: 'runtime', dim: 0.5}).running, false);
    assert(lifecycleCalls.every((uri) => uri.endsWith('/running')), 'Dismissed overlays must not relaunch or read power');
    runningOverlay = true;
    assert.strictEqual(overlay({action: 'state'}).running, true);
    overlay({action: 'runtime', compact: true});
    assert.strictEqual(lifecycleCalls.filter((uri) => uri.endsWith('/launch')).length, 1);
  } finally { luna = originalLuna; }
  console.log('notify selftest ok');
} else {
  main(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => { console.error(error.message); process.exit(3); });
}
