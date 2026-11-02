'use strict';
// webOS Foundry, on-TV server: the same HTTP API and web UI as `wof serve`, but it runs ON the TV and reaches the
// TV-side dispatcher locally (`sh dispatch.sh` with the request in $SSH_ORIGINAL_COMMAND) instead of over SSH.
// No npm dependencies: the TV has no package registry. Route shapes mirror webos_foundry/server.py field for field;
// see ARCHITECTURE.md section 10.4 and docs/TV-SERVER.md. Not implemented here: /api/jobs (file processing) and
// wake (Wake-on-LAN cannot be sent by the TV to itself).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {URL} = require('url');
const {execFile, spawn} = require('child_process');

// ---- install paths and settings (every WOF_TV_* variable exists for the offline tests; the TV sets none)
const ENV = process.env;
const DISPATCH_PATH = ENV.WOF_TV_DISPATCH || '/var/lib/webosbrew/webos-foundry/dispatch.sh';
const WEB_DIR = ENV.WOF_TV_WEB || path.join(__dirname, 'web');
const CONFIG_PATH = ENV.WOF_TV_CONFIG || path.join(__dirname, 'config.json');
const LOG_PATH = ENV.WOF_TV_LOG || '/tmp/webos-foundry-tv-server.log';
const LISTEN_HOST = ENV.WOF_TV_HOST || '0.0.0.0';
const LISTEN_PORT = ENV.WOF_TV_PORT === undefined ? 8766 : Number(ENV.WOF_TV_PORT);

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; " +
  "media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_JSON = 64 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024; // a 4K PNG capture is the largest reply
const STREAM_MAX_SECONDS = 600;
const STREAM_SIZES = {160: 90, 320: 180};
const AUTH_MODES = ['token', 'disabled'];
const PUBLIC = ['/api', '/api/health']; // no bearer token, ever
const NOTICE = 'No token set yet: see the log at /tmp/webos-foundry-tv-server.log or run `wof config show` from a paired PC.';
const BUSY = 'TV is busy with AI processing or another change; try again shortly.';
const MAGIC = 'C5F1'; // vtcap's stream header, rewritten to WOF1 for the browser (same as server.py)

const REMOTE_ACTIONS = ['power_off', 'home', 'back', 'up', 'down', 'left', 'right', 'ok', 'hdmi', 'volume_up',
  'volume_down', 'mute', 'unmute'];
// Only these settings can ever be read or written: [category, key, label].
const SETTINGS = [
  ['aiPicture', 'ai_Picture', 'AI Picture Pro'], ['aiPicture', 'ai_Brightness', 'AI Brightness'],
  ['aiPicture', 'ai_Genre', 'AI Genre'], ['picture', 'superResolution', 'Super Resolution'],
  ['sound', 'soundMode', 'Sound Mode'], ['sound', 'aiSound', 'AI Sound'], ['sound', 'clearVoice', 'Clear Voice'],
  ['sound', 'aigamesound', 'AI Game Sound'],
];
const DETAIL_TYPES = {lux: 'number', panel_hours: 'number', panel_temperature_c: 'number', pixel_refresher: 'object',
  power_on_reason: 'string', power_history: 'array', signal: 'object', sleep_timer: 'string', usage_today: 'array'};
const MAX_TREE_BYTES = 32768; // pre-flight check (dispatch.sh's CARD_MAX, the hard stdin ceiling, is more generous at 65536)
const CARD_KINDS = ['info', 'success', 'warning', 'alert'];
const CARD_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
const CARD_SIZES = ['xs', 's', 'm', 'l', 'xl', 'full'];
const TEXT_SIZES = ['xs', 's', 'm', 'l', 'xl'];
const TEXT_WEIGHTS = ['normal', 'strong'];
const TEXT_COLORS = ['fg', 'fg-2', 'info', 'success', 'warning', 'alert'];
const LIST_STYLES = ['bullet', 'number', 'plain'];
const WIDGET_TYPES = ['stack', 'row', 'text', 'image', 'badge', 'dot', 'progress', 'countdown', 'list', 'divider',
                      'compare', 'sparkline'];
const IMAGE_SHAPES = ['square', 'circle'];
const MAX_TREE_DEPTH = 5;
const MAX_TREE_NODES = 60;
const SHORTHAND_FIELDS = ['title', 'body', 'lines', 'image', 'kind'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => new ApiError(400, message);

// ---- log, config, auth

// The log holds the first-boot token, so it is created 0600 and never copied to stdout.
function log(message) {
  try { fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + message + '\n', {mode: 0o600}); } catch (e) { /* no log */ }
}

let configCache = {key: null, value: null};
function readConfig() { // {token, auth_mode} or null while there is no usable config file
  let stat;
  try { stat = fs.statSync(CONFIG_PATH); } catch (e) { return null; }
  const key = stat.mtimeMs + ':' + stat.size;
  if (configCache.key === key) return configCache.value;
  let value = null;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const mode = raw.auth_mode === undefined ? 'token' : raw.auth_mode;
    if (typeof raw.token === 'string' && raw.token && AUTH_MODES.includes(mode)) value = {token: raw.token, auth_mode: mode};
  } catch (e) { /* invalid: fail closed to the notice page */ }
  configCache = {key, value};
  return value;
}

function writeConfig(config) { // atomic, 0600
  const temporary = CONFIG_PATH + '.new';
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, CONFIG_PATH);
  configCache = {key: null, value: null};
}

function firstBoot() { // no config file at all: make a token and log it once
  if (fs.existsSync(CONFIG_PATH)) return;
  const token = crypto.randomBytes(32).toString('hex');
  try {
    writeConfig({token, auth_mode: 'token'});
    log('First start: generated the access token ' + token + ' (kept in ' + CONFIG_PATH + ', mode 0600). ' +
      'Send it as "Authorization: Bearer <token>" or paste it into the web UI.');
  } catch (error) {
    log('First start: cannot write ' + CONFIG_PATH + ': ' + error.message + '; serving the notice page only');
  }
}

const digest = (text) => crypto.createHash('sha256').update(text).digest();

function authError(config, urlPath, header) {
  if (PUBLIC.includes(urlPath) || config.auth_mode === 'disabled') return null;
  const text = header || '';
  const space = text.indexOf(' ');
  const presented = space >= 0 && text.slice(0, space).toLowerCase() === 'bearer' ? text.slice(space + 1).trim() : '';
  if (!presented) return [401, 'Missing bearer token: send Authorization: Bearer <server_token>'];
  if (crypto.timingSafeEqual(digest(presented), digest(config.token))) return null;
  return [401, 'Invalid bearer token'];
}

// A wildcard bind answers to any Host (the token is the defence); cross-site browser writes are still refused.
function callerError(method, host, origin, fetchSite) {
  if (method === 'GET') return null;
  if (origin !== undefined && origin !== 'http://' + host) return [403, 'Cross-origin requests are refused'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return [403, 'Cross-site requests are refused'];
  return null;
}

// ---- dispatcher (local): the same request strings dispatch.sh validates, never a Luna call from here

const runningTv = {chain: Promise.resolve()}; // one TV command from this server at a time
function withTvLock(task) {
  const result = runningTv.chain.then(task);
  runningTv.chain = result.catch(() => {});
  return result;
}

function dispatchError(code, stderr, killed, fallback) {
  const text = stderr.toString().trim();
  if (code === 75 || /busy/i.test(text)) return new ApiError(409, text || BUSY);
  if (killed) return new ApiError(502, 'The TV did not answer in time');
  return new ApiError(502, text || fallback);
}

function dispatch(command, timeoutMs, payload) { // resolves stdout (Buffer); payload, if given, is this request's stdin
  return new Promise((resolve, reject) => {
    const child = execFile('sh', [DISPATCH_PATH], {
      env: Object.assign({}, process.env, {SSH_ORIGINAL_COMMAND: command}),
      timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: 'buffer',
    }, (error, stdout, stderr) => (error ? reject(dispatchError(error.code, stderr, error.killed, error.message)) : resolve(stdout)));
    if (payload) child.stdin.end(payload); else child.stdin.end();
  });
}

const b64 = (text) => {
  const data = Buffer.from(text, 'utf8');
  if (data.toString('utf8') !== text) throw bad('Text must be valid Unicode');
  return data.toString('base64');
};
const CONTROL = /[\u0000-\u001f\u007f]/;
const length = (text) => Array.from(text).length; // code points, like Python's len()

function tvJson(out, what) {
  const text = out.toString();
  try { return JSON.parse(text); } catch (e) { throw new ApiError(502, 'TV returned malformed ' + what + ': ' + text.slice(-200)); }
}

function lastJsonLine(out) { // notify.js / apps.js: the reply is the last stdout line
  const text = out.toString();
  let reply = null;
  try { reply = JSON.parse(text.trim().split('\n').pop()); } catch (e) { /* malformed */ }
  if (!reply || typeof reply !== 'object' || reply.returnValue !== true) throw new ApiError(502, 'TV returned a malformed reply: ' + text.slice(-200));
  return reply;
}

// ---- status (port of tv.parse_status)

function parseDocuments(raw) { // concatenated JSON objects/arrays, as status.sh prints them
  const documents = [];
  let i = 0;
  for (;;) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) return documents;
    if (raw[i] !== '{' && raw[i] !== '[') throw new Error('Malformed status documents');
    let depth = 0, inString = false, j = i;
    for (; j < raw.length; j++) {
      const c = raw[j];
      if (inString) { if (c === '\\') j++; else if (c === '"') inString = false; } else if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) break;
    }
    if (depth !== 0) throw new Error('Malformed status documents');
    documents.push(JSON.parse(raw.slice(i, j + 1)));
    i = j + 1;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parsePower(raw) {
  const documents = parseDocuments(raw);
  if (documents.length !== 4) throw new Error('Expected power, foreground, Home manifest, and temperature');
  const [power, foreground, home, thermal] = documents;
  if (!isObject(power) || power.returnValue !== true || typeof power.state !== 'string') throw new Error('Power state unavailable');
  const rawPower = power.state;
  const state = rawPower === 'Active' || rawPower === 'Screen Saver' ? 'on' : rawPower === 'Active Standby' ? 'off' : 'unknown';
  let appId = null, source = null, isLuma = null;
  if (state === 'off') { source = 'Off'; isLuma = false; } else if (state === 'on') {
    if (!isObject(foreground) || foreground.returnValue !== true || typeof foreground.appId !== 'string') throw new Error('Foreground app unavailable');
    appId = foreground.appId || null;
    if (appId) {
      const main = isObject(home) && home.main !== undefined ? String(home.main) : '';
      isLuma = appId === 'com.ecklf.luma' || (appId === 'com.webos.app.home' && path.posix.basename(main) === 'luma');
      const prefix = 'com.webos.app.hdmi';
      if (isLuma) source = 'Luma';
      else if (appId === 'com.webos.app.home') source = 'LG Home';
      else if (appId.startsWith(prefix) && ['1', '2', '3', '4'].includes(appId.slice(prefix.length))) source = 'HDMI ' + appId.slice(prefix.length);
      else source = appId;
    }
  }
  // Temperature is independent: any bad reading hides only the temperature.
  const t = isObject(thermal) ? thermal : {};
  const milli = t.temperature_millicelsius;
  const valid = typeof milli === 'number' && milli >= 1000 && milli <= 149000 && typeof t.temperature_source === 'string' && t.temperature_source;
  return {power: state, raw_power_state: rawPower, app_id: appId, source, is_luma: isLuma,
    temperature_c: valid ? milli / 1000 : null, temperature_source: valid ? t.temperature_source : null};
}

function parseStatus(raw) { // status docs, '@@@', then audio getVolume
  const mark = raw.indexOf('@@@');
  const docs = (mark < 0 ? raw : raw.slice(0, mark)).replace('"ScreenSaver"', '"Screen Saver"').replace('"ActiveStandby"', '"Active Standby"');
  const status = parsePower(docs);
  let volume = null, muted = null;
  try {
    const reply = JSON.parse(mark < 0 ? '' : raw.slice(mark + 3));
    const v = isObject(reply) && reply.returnValue === true ? reply.volumeStatus : null;
    if (isObject(v) && Number.isInteger(v.volume) && Number.isInteger(v.maxVolume) && v.volume >= 0 && v.volume <= v.maxVolume &&
      typeof v.muteStatus === 'boolean') { volume = v.volume; muted = v.muteStatus; }
  } catch (e) { /* volume stays null */ }
  if (volume === null && status.power !== 'off') throw new Error('Volume status unavailable'); // never a guess while on
  return Object.assign(status, {volume, muted});
}

function parseDetails(out) {
  const doc = tvJson(out, 'details');
  const typeOf = (v) => (Array.isArray(v) ? 'array' : typeof v);
  if (!isObject(doc) || Object.keys(DETAIL_TYPES).some((k) => !(k in doc) || (doc[k] !== null && typeOf(doc[k]) !== DETAIL_TYPES[k]))) {
    throw new ApiError(502, 'TV returned malformed details: ' + out.toString().slice(-200));
  }
  const result = {};
  Object.keys(DETAIL_TYPES).forEach((k) => { result[k] = doc[k]; });
  return result;
}

// ---- settings

function settingItem(raw) {
  const label = isObject(raw) ? (SETTINGS.find((s) => s[0] === raw.category && s[1] === raw.key) || [])[2] : undefined;
  if (!label || typeof raw.value !== 'string' || !Array.isArray(raw.values) || !raw.values.every((v) => typeof v === 'string') ||
    typeof raw.available !== 'boolean' || !isObject(raw.context)) {
    throw new ApiError(502, 'TV returned a malformed setting: ' + JSON.stringify(raw).slice(0, 200));
  }
  return Object.assign({}, raw, {label});
}

// ---- notify validation (ports of notify.py)

function textPayload(text) {
  if (typeof text !== 'string') throw bad('Message must be text');
  text = text.trim();
  if (length(text) < 1 || length(text) > 200 || CONTROL.test(text)) throw bad('Message must be 1-200 characters without control characters');
  const encoded = b64(text);
  if (encoded.length > 400) throw bad('Message is too long to send (at most about 300 bytes of UTF-8)');
  return encoded;
}

function clean(value, max, what) {
  if (typeof value !== 'string' || length(value) > max) throw bad(what + ' must be text of at most ' + max + ' characters');
  if (CONTROL.test(value)) throw bad(what + ' must not contain control characters');
  return value.trim();
}

function checkEnum(value, choices, what) {
  if (!choices.includes(value)) throw bad(what + ' must be one of ' + choices.join(', '));
  return value;
}

function checkInt(value, lo, hi, what) {
  if (!Number.isInteger(value) || value < lo || value > hi) throw bad(what + ' must be an integer ' + lo + '-' + hi);
  return value;
}

function checkNode(node, depth, counter) {
  // Validates and normalises one widget tree node (ARCHITECTURE.md section 3a), recursively.
  // counter is a {n} box so the total-node cap applies across the whole tree, not one level.
  counter.n += 1;
  if (counter.n > MAX_TREE_NODES) throw bad('A card may have at most ' + MAX_TREE_NODES + ' widgets');
  if (depth > MAX_TREE_DEPTH) throw bad('A card may nest at most ' + MAX_TREE_DEPTH + ' levels deep');
  if (!isObject(node)) throw bad('Each widget must be a JSON object');
  const kind = node.type;
  if (!WIDGET_TYPES.includes(kind)) throw bad('Unknown widget type: ' + JSON.stringify(kind));
  const out = {type: kind};
  if (kind === 'stack' || kind === 'row') {
    const limit = kind === 'stack' ? 20 : 10;
    if (!Array.isArray(node.children) || node.children.length < 1 || node.children.length > limit) {
      throw bad(kind + ' needs 1-' + limit + ' children');
    }
    if ('gap' in node) out.gap = checkInt(node.gap, 0, 48, 'gap');
    if ('align' in node) out.align = checkEnum(node.align, ['start', 'center', 'end'], 'align');
    out.children = node.children.map((child) => checkNode(child, depth + 1, counter));
  } else if (kind === 'text') {
    out.text = clean(node.text, 400, 'text');
    if ('size' in node) out.size = checkEnum(node.size, TEXT_SIZES, 'size');
    if ('weight' in node) out.weight = checkEnum(node.weight, TEXT_WEIGHTS, 'weight');
    if ('color' in node) out.color = checkEnum(node.color, TEXT_COLORS, 'color');
  } else if (kind === 'image') {
    if (typeof node.src !== 'string' || node.src.length > 500 || !/^https?:\/\/[^\s"'<>]+$/.test(node.src)) {
      throw bad('image src must be an http(s) URL of at most 500 characters');
    }
    out.src = node.src;
    if ('shape' in node) out.shape = checkEnum(node.shape, IMAGE_SHAPES, 'shape');
  } else if (kind === 'badge') {
    out.text = clean(node.text, 24, 'badge text');
    if ('tone' in node) out.tone = checkEnum(node.tone, CARD_KINDS, 'tone');
  } else if (kind === 'dot') {
    if ('tone' in node) out.tone = checkEnum(node.tone, CARD_KINDS, 'tone');
  } else if (kind === 'progress') {
    if (typeof node.value !== 'number' || Number.isNaN(node.value) || node.value < 0 || node.value > 1) {
      throw bad('progress value must be a number 0-1');
    }
    out.value = node.value;
    if ('label' in node) out.label = clean(node.label, 40, 'label');
    if ('tone' in node) out.tone = checkEnum(node.tone, CARD_KINDS, 'tone');
  } else if (kind === 'countdown') {
    if (typeof node.target !== 'string' || Number.isNaN(Date.parse(node.target))) {
      throw bad('countdown target must be an ISO 8601 datetime string');
    }
    out.target = node.target;
    if ('label' in node) out.label = clean(node.label, 40, 'label');
  } else if (kind === 'list') {
    if (!Array.isArray(node.items) || node.items.length < 1 || node.items.length > 10) throw bad('list needs 1-10 items');
    out.items = node.items.map((item) => clean(item, 120, 'Each item'));
    if ('style' in node) out.style = checkEnum(node.style, LIST_STYLES, 'style');
  } else if (kind === 'compare') {
    if (!Array.isArray(node.segments) || node.segments.length < 2 || node.segments.length > 4) {
      throw bad('compare needs 2-4 segments');
    }
    out.segments = node.segments.map(checkSegment);
  } else if (kind === 'sparkline') {
    if (!Array.isArray(node.points) || node.points.length < 3 || node.points.length > 24) {
      throw bad('sparkline needs 3-24 points');
    }
    if (!node.points.every((p) => typeof p === 'number' && !Number.isNaN(p) && p >= -1 && p <= 1)) {
      throw bad('sparkline points must be numbers between -1 and 1');
    }
    out.points = node.points.map(Number);
    if ('tone' in node) out.tone = checkEnum(node.tone, CARD_KINDS, 'tone');
  } // divider has no fields
  return out;
}

function checkSegment(segment) {
  if (!isObject(segment)) throw bad('Each compare segment must be a JSON object');
  const out = {label: clean(segment.label, 24, 'segment label'), value: clean(segment.value, 16, 'segment value')};
  if (typeof segment.fraction !== 'number' || Number.isNaN(segment.fraction) || segment.fraction < 0 || segment.fraction > 1) {
    throw bad('segment fraction must be a number 0-1');
  }
  out.fraction = segment.fraction;
  if ('tone' in segment) out.tone = checkEnum(segment.tone, CARD_KINDS, 'tone');
  return out;
}

function cleanShorthand(card) {
  // The original five flat card fields, validated exactly as the pre-tree checkCard() did.
  const out = {};
  if ('title' in card) out.title = clean(card.title, 80, 'title');
  if ('body' in card) out.body = clean(card.body, 400, 'body');
  if ('lines' in card) {
    if (!Array.isArray(card.lines) || card.lines.length > 10) throw bad('lines must be a list of at most 10 texts');
    out.lines = card.lines.map((line) => clean(line, 120, 'Each line'));
  }
  if ('image' in card) {
    if (typeof card.image !== 'string' || card.image.length > 500 || !/^https?:\/\/[^\s"'<>]+$/.test(card.image)) {
      throw bad('image must be an http(s) URL of at most 500 characters');
    }
    out.image = card.image;
  }
  if ('kind' in card) out.kind = checkEnum(card.kind, CARD_KINDS, 'kind');
  if (!out.title && !out.body && !(out.lines && out.lines.length) && !out.image) {
    throw bad('An overlay card needs a title, body, lines, image or a root widget tree');
  }
  return out;
}

function compileCard(card) {
  // The flat shorthand fields -> an equivalent widget tree, so every existing caller (the web UI's
  // basic card form, the Home Assistant overlay_show service, wof overlay) keeps working unchanged;
  // the TV-side renderer only ever sees a tree, never the flat shape.
  const head = [];
  if (card.title || 'kind' in card) {
    const row = [{type: 'dot', tone: card.kind || 'info'}];
    if (card.title) row.push({type: 'text', text: card.title, size: 'l', weight: 'strong'});
    head.push({type: 'row', gap: 14, align: 'center', children: row});
  }
  const body = [];
  if (card.body) body.push({type: 'text', text: card.body, color: 'fg-2'});
  if (card.lines && card.lines.length) body.push({type: 'list', items: card.lines});
  if (card.image) body.push({type: 'image', src: card.image});
  return {type: 'stack', gap: 12, children: head.concat(body)};
}

function checkOverlayRequest(body) {
  // Validate a POST /api/overlay body. Either {"hide": true} alone, or a card: {"position"?,
  // "size"?, "seconds"?, "root": <widget tree>} for the general case, or the shorthand {"title"?,
  // "body"?, "lines"?, "image"?, "kind"?, "position"?, "size"?, "seconds"?} compiled into an
  // equivalent tree here -- the dispatcher and the TV only ever see a tree.
  if (!isObject(body)) throw bad('The card must be a JSON object');
  if (body.hide === true) {
    if (Object.keys(body).length !== 1) throw bad('Use {"hide": true} alone to hide the overlay');
    return {hide: true};
  }
  const out = {};
  if ('position' in body) out.position = checkEnum(body.position, CARD_POSITIONS, 'position');
  if ('size' in body) out.size = checkEnum(body.size, CARD_SIZES, 'size');
  if ('seconds' in body) out.seconds = checkInt(body.seconds, 0, 300, 'seconds');
  const extras = ['position', 'size', 'seconds'];
  if ('root' in body) {
    const unknown = Object.keys(body).filter((k) => !extras.includes(k) && k !== 'root');
    if (unknown.length) throw bad('Unknown overlay field: ' + unknown.join(', '));
    out.root = checkNode(body.root, 0, {n: 0});
  } else {
    const unknown = Object.keys(body).filter((k) => !extras.includes(k) && !SHORTHAND_FIELDS.includes(k));
    if (unknown.length) throw bad('Unknown overlay field: ' + unknown.join(', '));
    const card = {};
    SHORTHAND_FIELDS.forEach((key) => { if (key in body) card[key] = body[key]; });
    out.root = checkNode(compileCard(cleanShorthand(card)), 0, {n: 0});
  }
  const encoded = Buffer.from(JSON.stringify(out), 'utf8');
  if (encoded.length > MAX_TREE_BYTES) throw bad('Card is too large (at most ' + MAX_TREE_BYTES + ' bytes of JSON)');
  return out;
}

async function sendCard(card) {
  const payload = Buffer.from(JSON.stringify(card), 'utf8');
  const reply = lastJsonLine(await dispatch('notify-overlay', 30000, payload));
  return 'Overlay card ' + reply.overlay;
}


// ---- screenshot / stream arguments

function intParam(text, name) {
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw bad(name + ' must be an integer');
  return parseInt(text, 10);
}

function roundHalfEven(x) { // Python's round(), so the height matches the PC server's
  const floor = Math.floor(x), diff = x - floor;
  return diff < 0.5 ? floor : diff > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
}

const SHOT_FORMATS = {jpg: [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png']};

function streamArgs(query) {
  let width, height, fps;
  try {
    width = intParam(query.width === undefined ? '160' : query.width, 'width');
    height = intParam(query.height === undefined ? String(STREAM_SIZES[width] || 0) : query.height, 'height');
    fps = intParam(query.fps === undefined ? '30' : query.fps, 'fps');
  } catch (e) { throw bad('width, height and fps must be integers'); }
  if (STREAM_SIZES[width] !== height) throw bad('Size must be 160\u00d790 or 320\u00d7180');
  if (fps < 10 || fps > 60) throw bad('fps must be 10-60');
  return [width, height, fps];
}

// ---- route handlers: (ctx) -> body | undefined when already sent

const getHealth = () => ({paired: true, tv_host: '127.0.0.1'});

async function getStatus() {
  const out = await dispatch('status', 12000);
  try { return parseStatus(out.toString()); } catch (e) { throw new ApiError(502, e.message); }
}

async function postRemote(ctx) {
  const action = ctx.params.action;
  if (action === 'wake') throw new ApiError(501, 'Wake is not available on the on-TV server: it runs on the TV, which cannot send itself a Wake-on-LAN packet. Use the PC-hosted server or the TV remote');
  if (!REMOTE_ACTIONS.includes(action)) throw new ApiError(404, 'Unknown remote action; GET /api lists them');
  const value = (await ctx.jsonBody(false)).value;
  if (action === 'hdmi') {
    if (!Number.isInteger(value) || value < 1 || value > 4) throw bad('HDMI input must be the integer 1-4');
  } else if (value !== undefined && value !== null) throw bad('This remote action takes no value');
  const command = action === 'hdmi' ? 'remote hdmi ' + value : 'remote ' + action;
  return withTvLock(async () => {
    const reply = tvJson(await dispatch(command, 45000), 'reply');
    const message = isObject(reply) ? reply.message : reply;
    if (typeof message !== 'string') throw new ApiError(502, 'TV returned a malformed reply');
    return {action, message};
  });
}

function getSettings() {
  return withTvLock(async () => {
    const items = tvJson(await dispatch('settings-list', 45000), 'settings list');
    if (!Array.isArray(items)) throw new ApiError(502, 'TV returned a malformed settings list');
    const order = (item) => SETTINGS.findIndex((s) => s[0] === item.category && s[1] === item.key);
    return items.map(settingItem).sort((a, b) => order(a) - order(b));
  });
}

async function putSetting(ctx) {
  const {category, key} = ctx.params;
  const body = await ctx.jsonBody(true);
  const setting = SETTINGS.find((s) => s[0] === category && s[1] === key);
  if (!setting) throw bad('Unsupported setting');
  if (typeof body.value !== 'string' || !body.value) throw bad('Setting value must be a non-empty string');
  const context = body.context;
  if (!isObject(context) || !Object.keys(context).every((k) => typeof context[k] === 'string')) {
    throw bad('Setting context must be the context dict returned by get_settings');
  }
  const payload = b64(JSON.stringify({value: body.value, context}));
  if (payload.length > 4000) throw bad('The setting value and context are too large');
  return withTvLock(async () => {
    const reply = tvJson(await dispatch('settings-set ' + category + ' ' + key + ' ' + payload, 45000), 'reply');
    const prefixed = isObject(reply); // {"message": ...} arrives label-prefixed; a bare string does not
    const text = prefixed ? reply.message : reply;
    if (typeof text !== 'string') throw new ApiError(502, 'TV returned a malformed reply');
    return {message: prefixed ? text : setting[2] + ': ' + text};
  });
}

async function getDetails() { return parseDetails(await dispatch('details', 20000)); }

async function postToast(ctx) {
  const body = await ctx.jsonBody(true);
  lastJsonLine(await dispatch('notify-toast ' + textPayload(body.message), 20000));
  return {message: 'Toast shown on the TV'};
}

async function postSay(ctx) {
  const body = await ctx.jsonBody(true);
  const encoded = textPayload(body.message);
  const volume = body.volume === undefined ? 15 : body.volume;
  if (!Number.isInteger(volume) || volume < 1 || volume > 40) throw bad('Volume must be an integer 1-40');
  return withTvLock(async () => {
    const reply = lastJsonLine(await dispatch('notify-say ' + encoded + ' ' + volume, 60000));
    return {message: 'Spoke ' + reply.spoke + ' characters at volume ' + reply.volume +
      "; the TV's volume, mute and Audio Guidance are restored"};
  });
}

async function postOverlay(ctx) {
  const body = await ctx.jsonBody(true);
  return {message: await sendCard(checkOverlayRequest(body))};
}

async function getScreenshot(ctx) {
  const width = intParam(ctx.query.width === undefined ? '1920' : ctx.query.width, 'width');
  const height = roundHalfEven(width * 9 / 32) * 2; // 16:9, rounded to even
  const format = ctx.query.format === undefined ? 'jpg' : ctx.query.format;
  if (width % 2 || height % 2) throw bad('Width and height must be even integers');
  if (width < 64 || width > 3840 || height < 36 || height > 2160) throw bad('Width must be 64-3840 and height 36-2160');
  if (Math.abs(width * 9 - height * 16) > 16) throw bad('Height must keep the 16:9 picture shape');
  if (!SHOT_FORMATS[format]) throw bad('Format must be jpg or png');
  const data = await dispatch('screenshot ' + width + ' ' + height + ' ' + format, 30000);
  if (data.slice(0, SHOT_FORMATS[format][0].length).compare(SHOT_FORMATS[format][0]) !== 0) {
    throw new ApiError(502, 'TV returned a malformed ' + format + ' capture');
  }
  ctx.sendBytes(200, data, SHOT_FORMATS[format][1]);
}

const live = {active: null}; // one live view at a time
function getStream(ctx) {
  const [width, height, fps] = streamArgs(ctx.query);
  if (live.active) throw new ApiError(409, 'A live view is already running; stop it first');
  return new Promise((resolve, reject) => {
    const {res} = ctx;
    const child = spawn('sh', [DISPATCH_PATH], {
      env: Object.assign({}, process.env, {SSH_ORIGINAL_COMMAND: ['stream-start', width, height, fps, 0, 2].join(' ')}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.active = child;
    let head = Buffer.alloc(0), started = false, stderr = '';
    // The command is exec'd on the TV, so killing the process IS stopping the capture.
    const timer = setTimeout(() => child.kill('SIGTERM'), STREAM_MAX_SECONDS * 1000);
    const fail = () => reject(new ApiError(502, stderr.trim().slice(-500) || 'vtcap did not start (is it installed? run `wof install --vtcap yes`)'));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    child.on('error', (error) => { stderr += error.message; });
    child.stdout.on('data', (chunk) => {
      if (started) {
        if (!res.write(chunk)) { child.stdout.pause(); res.once('drain', () => child.stdout.resume()); }
        return;
      }
      head = Buffer.concat([head, chunk]);
      if (head.length < 8) return;
      const w = head.readUInt16LE(4), h = head.readUInt16LE(6), frame = w * h * 3;
      if (head.toString('latin1', 0, 4) !== MAGIC || !frame || frame > 8 * 1024 * 1024) { child.kill('SIGTERM'); return; }
      if (head.length < 8 + frame) return; // the first whole frame must arrive before any header goes out
      started = true;
      res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP});
      const out = Buffer.from(head.slice(8));
      const header = Buffer.from('WOF1\0\0\0\0', 'latin1');
      header.writeUInt16LE(w, 4);
      header.writeUInt16LE(h, 6);
      res.write(header);
      res.write(out);
    });
    child.on('close', () => {
      clearTimeout(timer);
      live.active = null;
      if (started) res.end(); else fail();
      resolve();
    });
    res.on('close', () => child.kill('SIGTERM')); // the viewer left
  });
}

// ---- apps (dispatcher verbs app-list / app-install / app-uninstall; TV-side mechanism: apps.js)

async function getApps() {
  const apps = tvJson(await dispatch('app-list', 20000), 'app list');
  if (!Array.isArray(apps)) throw new ApiError(502, 'TV returned a malformed app list');
  return apps;
}

function appResult(out, done) {
  const lines = out.toString().trim().split('\n');
  const reply = tvJson(Buffer.from(lines[lines.length - 1]), 'reply'); // apps.js prints one terminal line; tolerate progress lines before it
  if (!isObject(reply) || typeof reply.returnValue !== 'boolean') throw new ApiError(502, 'TV returned a malformed reply: ' + out.toString().slice(-200));
  if (!reply.returnValue) throw new ApiError(502, reply.errorText || reply.statusText || reply.message || 'The TV refused the request');
  return {message: done};
}

async function postApp(ctx) {
  if (ctx.req.headers['content-type'] !== undefined && ctx.req.headers['content-type'].split(';')[0].trim() !== 'application/json') {
    throw new ApiError(415, 'Uploading an IPK is not supported by the on-TV server; send application/json {"url", "sha256"}');
  }
  const body = await ctx.jsonBody(true);
  const extra = Object.keys(body).filter((k) => k !== 'url' && k !== 'sha256');
  if (extra.length) throw bad('Unknown field: ' + extra.join(', '));
  if (typeof body.url !== 'string' || body.url.length > 500 || !/^https?:\/\/[^\s"'<>]+$/.test(body.url)) {
    throw bad('url must be an http(s) URL of at most 500 characters');
  }
  const payload = {url: body.url};
  if (body.sha256 !== undefined && body.sha256 !== null) {
    if (typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) throw bad('sha256 must be 64 lowercase hex characters');
    payload.sha256 = body.sha256;
  }
  const command = 'app-install ' + b64(JSON.stringify(payload));
  return withTvLock(async () => appResult(await dispatch(command, 100000), 'App installed'));
}

async function deleteApp(ctx) {
  let id;
  try { id = decodeURIComponent(ctx.params.id); } catch (e) { throw bad('Invalid app id'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) throw bad('Invalid app id');
  return withTvLock(async () => appResult(await dispatch('app-uninstall ' + b64(id), 100000), 'App removed'));
}

// ---- auth config

const AUTH_NOTES = {token: '', disabled: 'Login is off: anyone who can reach this server can control the TV.'};
const authState = (mode) => ({mode, note: AUTH_NOTES[mode]});
const getAuth = () => authState(readConfig().auth_mode);

async function patchAuth(ctx) {
  const body = await ctx.jsonBody(true);
  if (!AUTH_MODES.includes(body.mode)) throw bad('mode must be one of ' + AUTH_MODES.join(', '));
  if (body.confirm !== true) throw bad('Send "confirm": true to change the auth mode');
  const config = readConfig();
  writeConfig({token: config.token, auth_mode: body.mode});
  log('auth_mode set to ' + body.mode);
  return authState(body.mode);
}

// ---- route table and catalogue

const TV_LOCK_NOTE = 'Runs as one node process on the TV under /tmp/webos-foundry.lock, so a check-change-readback cannot ' +
  'interleave with another client.';
const REMOTE = {
  power_off: ['Standby', 'luna://com.webos.service.tvpower/power/powerOff, then getPowerState until Active Standby'],
  home: ['Home key; opens Luma', 'networkinput/sendSpecialKey {"key":"HOME"}, then waits for com.webos.app.home in front'],
  back: ['Back key', 'networkinput/sendSpecialKey {"key":"BACK"}'],
  up: ['Up key', 'networkinput/sendSpecialKey {"key":"UP"}'],
  down: ['Down key', 'networkinput/sendSpecialKey {"key":"DOWN"}'],
  left: ['Left key', 'networkinput/sendSpecialKey {"key":"LEFT"}'],
  right: ['Right key', 'networkinput/sendSpecialKey {"key":"RIGHT"}'],
  ok: ['OK key', 'networkinput/sendSpecialKey {"key":"ENTER"}'],
  hdmi: ['Switch input; body {"value": 1-4}', 'applicationManager/launch {"id":"com.webos.app.hdmiN"}, then getForegroundAppInfo until it is in front'],
  volume_up: ['Volume +1 on the TV speaker', 'audio/master/setVolume, then getVolume readback'],
  volume_down: ['Volume \u22121 on the TV speaker', 'audio/master/setVolume, then getVolume readback'],
  mute: ['Mute the TV speaker', 'audio/master/muteVolume {"mute":true}, then getVolume readback'],
  unmute: ['Unmute the TV speaker', 'audio/master/muteVolume {"mute":false}, then getVolume readback'],
};

function route(method, routePath, group, summary, handler, doc) {
  const names = [];
  const pattern = routePath.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, name) => { names.push(name); return '([^/]+)'; });
  return Object.assign({method, path: routePath, group, summary}, doc, {handler, regex: new RegExp('^' + pattern + '$'), names});
}

const ROUTES = [
  route('GET', '/api', 'Reference', 'This catalogue: TV address, processing profiles and every route.', apiIndex, {
    returns: 'Catalogue object', tv: [],
    notes: 'Needs no token. This is the on-TV server: it has NO Processing group (/api/jobs is not implemented here, ' +
      'use the PC-hosted server for AI picture and sound file processing) and no wake action.',
    example: {path: '/api'}}),
  route('GET', '/api/health', 'Reference', 'Whether this install is paired with a TV, and its address. The only route besides GET /api that needs no token.', getHealth, {
    returns: '{"paired": bool, "tv_host": str | null}', tv: [],
    notes: 'Always {"paired": true, "tv_host": "127.0.0.1"}: this server runs on the TV itself.', example: {path: '/api/health'}}),
  route('GET', '/api/status', 'Status', 'Power, foreground source, Luma, SoC temperature, volume and mute.', getStatus, {
    returns: '{"power": "on|off|unknown", "raw_power_state", "source": "HDMI 1|Luma|LG Home|Off|\u2026", "app_id", ' +
      '"is_luma", "temperature_c", "temperature_source", "volume", "muted"} \u2014 volume/muted are null in standby',
    tv: ['dispatch verb status \u2192 sh status.sh: tvpower/power/getPowerState, applicationManager/getForegroundAppInfo, ' +
      'the mounted Home manifest (Luma check), /proc/thermalinfo/soc_temperature', 'luna://com.webos.service.audio/master/getVolume'],
    notes: 'Read-only; does not take the TV lock.', example: {path: '/api/status'}}),
  route('GET', '/api/details', 'Status', "OLED panel hours and temperature, pixel refresher runs, power-on reason and history, ambient light, " +
    "input signal, sleep timer and today's app usage.", getDetails, {
    returns: '{"lux": int, "panel_hours": int, "panel_temperature_c": int, "pixel_refresher": {"full_runs", "full_last_panel_hours", ' +
      '"standby_runs", "standby_last_panel_hours"}, "power_on_reason": str, "power_history": [{"reason", "panel_hours"}], "signal": {...}, ' +
      '"sleep_timer": str, "usage_today": [{"app_id", "seconds", "launches"}]} \u2014 a field is null when its TV service did not answer',
    tv: ['dispatch verb details \u2192 node details.js'], notes: 'Read-only and takes no TV lock. Never calls a setter, refresher or reset.',
    example: {path: '/api/details'}}),
  route('POST', '/api/notify/toast', 'Notify', 'Show a message on the TV screen as a toast.', postToast, {
    body: '{"message": "1-200 characters, no control characters"}', returns: '{"message": "Toast shown on the TV"}',
    tv: ['dispatch verb notify-toast \u2192 node notify.js toast BASE64: luna://com.webos.notification/createToast'],
    notes: 'Takes no TV lock and does not change any setting.',
    example: {path: '/api/notify/toast', body: {message: 'Dinner is ready'}}}),
  route('POST', '/api/notify/say', 'Notify', 'Speak a message through the TV speaker (text to speech) at a chosen volume, then restore the TV.', postSay, {
    body: '{"message": "1-200 characters, no control characters", "volume": 1-40 (optional, default 15)}',
    returns: '{"message": "Spoke N characters at volume V; \u2026restored"}',
    tv: ['dispatch verb notify-say \u2192 node notify.js say BASE64 VOLUME: borrows audioGuidance, volume and mute, speaks with ' +
      'luna://com.webos.service.tts/speak, then restores all three and reads them back'],
    notes: TV_LOCK_NOTE + ' It needs TV-speaker output and the TV on; volume is on the TV\'s 0-100 scale.',
    example: {path: '/api/notify/say', body: {message: 'Dinner is ready', volume: 10}}}),
  route('POST', '/api/overlay', 'Notify', 'Show a custom card on the TV, built from your own JSON layout of widgets, or hide it.', postOverlay, {
    body: 'Either {"hide": true} alone, or {"position"?, "size"?, "seconds"?, "root": <widget tree>}, or the shorthand ' +
      '{"title"?, "body"?, "lines"?, "image"?, "kind"?, "position"?, "size"?, "seconds"?} compiled into an equivalent ' +
      'tree. position: top-left|top-right|bottom-left|bottom-right|center (default top-right). size: xs|s|m|l|xl|full ' +
      '(default m). seconds: 0-300, 0 = stays until hidden (default 8). A widget node is {"type": stack|row|text|' +
      'image|badge|dot|progress|countdown|list|divider, ...fields, "children"?: [...] for stack/row}; depth \u2264 4, ' +
      '\u2264 40 widgets total, \u2264 32768 bytes of JSON. Full per-type field list: ARCHITECTURE.md section 3a.',
    returns: '{"message": "Overlay card shown|hidden"}',
    tv: ['dispatch verb notify-overlay \u2192 node notify.js overlay: reads the tree from stdin, launches dev.webosfoundry.overlay with it as params'],
    notes: 'The foreground app does not change. The TV must be on; an invalid card or a TV in standby answers 502 with the TV script\'s message. ' +
      'The image URL is fetched by the TV, so it must be reachable from the TV.',
    example: {path: '/api/overlay', body: {title: 'Dinner', body: 'It is ready.', kind: 'success', position: 'top-right', seconds: 10}}}),
  route('GET', '/api/screenshot', 'Status', "Capture the picture the TV shows from its HDMI input (without the TV's own menus) as an image.", getScreenshot, {
    query: {width: '64-3840, even (default 1920); the height follows the 16:9 picture', format: 'jpg (default) or png'},
    returns: 'image/jpeg or image/png bytes, Cache-Control: no-store',
    tv: ['dispatch verb screenshot \u2192 luna://com.webos.service.capture/executeOneShot {"method": "VIDEO", ...}, cat the file, rm it'],
    notes: 'PRIVACY: this is whatever the connected source shows. Nothing is stored and the TV file is deleted, but the response is the full ' +
      'picture: do not share it. Copy-protected (HDCP) sources cannot be captured and answer 502.',
    example: {path: '/api/screenshot?width=960&format=jpg'}}),
  route('GET', '/api/screen/stream', 'Status', 'Live low-resolution view of the HDMI picture: raw RGB frames in a close-delimited binary stream.', getStream, {
    query: {width: '160 (default) or 320', height: '90 for width 160 (default), 180 for width 320', fps: '10-60 (default 30)'},
    returns: "application/octet-stream, no Content-Length: the bytes 'WOF1', u16le width, u16le height, then frames of width*height*3 bytes " +
      'of RGB24 in a row-major loop until the client disconnects, the 10-minute cap passes or the TV stops',
    tv: ['dispatch verb stream-start \u2192 native vtcap client run locally: libvtcapture display-output tap at the requested size and rate; stopped (SIGTERM) when the stream ends'],
    notes: 'PRIVACY: this is the connected source, live. One stream at a time (409 while another runs), 502 when the capture client cannot start ' +
      '(for example the vtcap role is not installed: run wof install). Close the connection to stop it.',
    stream: true, example: {path: '/api/screen/stream?width=160&height=90&fps=30'}}),
  route('POST', '/api/remote/{action}', 'Remote', 'Send one remote action and wait for the TV to confirm it.', postRemote, {
    body: 'Optional JSON. Only hdmi takes a body: {"value": 1-4}', returns: '{"action": "\u2026", "message": "what the TV confirmed"}',
    values: Object.keys(REMOTE).map((name) => ({name, detail: REMOTE[name][0], tv: REMOTE[name][1]})),
    tv: [], notes: TV_LOCK_NOTE + ' There is no wake action: this server runs on the TV and cannot send itself a Wake-on-LAN packet (answers 501).',
    example: {path: '/api/remote/hdmi', body: {value: 1}}}),
  route('GET', '/api/settings', 'Picture & sound', 'The allowed AI picture and sound settings, as the TV reports them now.', getSettings, {
    returns: '[{"category", "key", "label", "value", "values": [allowed now], "available": bool, "context": {axis: value}}] \u2014 ' +
      'context is the input/mode scope the value belongs to; {} means global',
    tv: ['dispatch verb settings-list \u2192 node settings.js list: settings/getSystemSettingDesc and getSystemSettings per category'],
    values: SETTINGS.map((s) => ({name: s[0] + '.' + s[1], detail: s[2]})), notes: TV_LOCK_NOTE, example: {path: '/api/settings'}}),
  route('PUT', '/api/settings/{category}/{key}', 'Picture & sound', 'Change one setting. It persists on the TV in the scope given by its context.', putSetting, {
    body: '{"value": "one of values", "context": the context object from GET /api/settings}', returns: '{"message": "\u2026"}',
    tv: ['dispatch verb settings-set \u2192 node settings.js set: rechecks context, availability and allowed values, calls settings/setSystemSettings, then reads the value back'],
    notes: TV_LOCK_NOTE + ' A changed input or picture mode since the read is refused, so a value never lands in the wrong scope.',
    example: {path: '/api/settings/sound/aiSound', body: {value: 'on', context: {}}}}),
  route('GET', '/api/apps', 'Apps', 'Homebrew and other removable apps installed on the TV.', getApps, {
    returns: '[{"id", "title", "icon", "version", "removable"}]',
    tv: ['dispatch verb app-list \u2192 node apps.js list: applicationManager/listApps filtered to removable apps'],
    notes: 'System apps are not removable and are not listed (heuristic, not a dedicated Homebrew API).', example: {path: '/api/apps'}}),
  route('POST', '/api/apps', 'Apps', 'Install a Homebrew app from an IPK URL; the TV downloads and verifies it itself.', postApp, {
    body: '{"url": "http(s) URL, \u2264500 chars", "sha256"?: "64 lowercase hex chars"} as application/json',
    returns: '{"message": "App installed"} after the install finishes (up to 90 s)',
    tv: ['dispatch verb app-install \u2192 node apps.js install: curl-downloads the URL locally, then ' +
         'luna://com.webos.appInstallService/dev/install, streamed until "state":"installed"'],
    notes: 'Raw IPK upload is not supported by the on-TV server (415): host the file somewhere the TV can fetch it.',
    example: {path: '/api/apps', body: {url: 'https://example.org/app.ipk', sha256: '0'.repeat(64)}}}),
  route('DELETE', '/api/apps/{id}', 'Apps', 'Uninstall an app by id.', deleteApp, {
    returns: '{"message": "App removed"}',
    tv: ['dispatch verb app-uninstall \u2192 node apps.js uninstall: luna://com.webos.appInstallService/dev/remove, ' +
         'streamed until "state":"removed"'],
    example: {path: '/api/apps/com.example.app'}}),
  route('GET', '/api/config/auth', 'Settings', 'The token mode of this server: token or disabled.', getAuth, {
    returns: '{"mode": "token" | "disabled", "note": str}', tv: [],
    notes: '"disabled" means no route requires the token on this LAN-reachable server; the UI should show a persistent warning.',
    example: {path: '/api/config/auth'}}),
  route('PATCH', '/api/config/auth', 'Settings', 'Switch between requiring the token and requiring none.', patchAuth, {
    body: '{"mode": "token" | "disabled", "confirm": true}', returns: '{"mode": ..., "note": str}', tv: [],
    notes: 'confirm must be literally true. Stored in this server\'s own config file, independent of the PC-hosted server.',
    example: {path: '/api/config/auth', body: {mode: 'token', confirm: true}}}),
];

function apiIndex(ctx) {
  return {
    tv: {address: '127.0.0.1'},
    base: 'http://' + (ctx.req.headers.host || ctx.req.socket.localAddress + ':' + ctx.req.socket.localPort),
    auth: 'Authorization: Bearer <server_token> on every route except GET /api and GET /api/health, unless the auth mode is disabled.',
    errors: 'Every non-2xx response is {"error": "message"}. 401 means the bearer token is missing or wrong; 409 means the TV is busy ' +
      'with another change; 501 means the action does not exist on the on-TV server; 502 means the TV refused or did not answer.',
    kinds: {},
    unavailable: [{group: 'Processing', paths: ['/api/jobs'],
      notes: 'AI picture and sound file processing is not implemented by the on-TV server; use the PC-hosted server.'}],
    routes: ROUTES.map((r) => { const o = Object.assign({}, r); delete o.handler; delete o.regex; delete o.names; return o; }),
  };
}

// ---- HTTP plumbing

function sendBytes(res, status, data, kind, headers) {
  res.writeHead(status, Object.assign({'Content-Type': kind, 'Content-Length': data.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP}, headers));
  res.end(data);
}
const sendJson = (res, status, body, headers) => sendBytes(res, status, Buffer.from(JSON.stringify(body)), 'application/json', headers);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (req.headers['transfer-encoding'] !== undefined) return reject(new ApiError(411, 'Send a Content-Length; chunked bodies are not accepted'));
    const raw = req.headers['content-length'];
    const size = raw === undefined ? 0 : /^\s*\d+\s*$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (Number.isNaN(size)) return reject(new ApiError(400, 'Invalid Content-Length'));
    if (size > limit) return reject(new ApiError(413, 'Request body is too large'));
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    return undefined;
  });
}

async function jsonBody(req, required) {
  const raw = await readBody(req, MAX_JSON);
  if (!raw.length) {
    if (required) throw new ApiError(400, 'Send a JSON body');
    return {};
  }
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'Send the body as application/json');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) { throw bad('Invalid JSON: ' + e.message); }
  if (!isObject(body)) throw bad('The JSON body must be an object');
  return body;
}

function staticFile(urlPath) { // {data, kind} or null; only regular files under WEB_DIR, no escapes
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) return null;
  if (decoded.endsWith('/') || !parts.length) parts.push('index.html');
  try {
    const root = fs.realpathSync(WEB_DIR);
    const file = fs.realpathSync(path.join(root, ...parts));
    if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) return null;
    return {data: fs.readFileSync(file), kind: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'};
  } catch (e) { return null; }
}

const NOTICE_PAGE = Buffer.from('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
  '<title>webOS Foundry</title><h1>webOS Foundry</h1><p>' + NOTICE.replace(/`/g, '') + '</p></html>');

async function handle(req, res) {
  const url = new URL(req.url, 'http://tv');
  const urlPath = url.pathname;
  try {
    const refused = callerError(req.method, req.headers.host, req.headers.origin, req.headers['sec-fetch-site']);
    if (refused) throw new ApiError(refused[0], refused[1]);
    const config = readConfig();
    if (!config) { // no usable token yet: only this read-only notice, never the control UI
      if (req.method === 'GET' && urlPath === '/') return sendBytes(res, 200, NOTICE_PAGE, 'text/html; charset=utf-8');
      throw new ApiError(503, NOTICE);
    }
    if (req.method === 'GET' && !urlPath.startsWith('/api')) {
      const file = staticFile(urlPath);
      if (file) return sendBytes(res, 200, file.data, file.kind);
    }
    const denied = authError(config, urlPath, req.headers.authorization);
    if (denied) throw new ApiError(denied[0], denied[1]);
    const methods = [];
    let found = null;
    for (const item of ROUTES) {
      const match = item.regex.exec(urlPath);
      if (!match) continue;
      if (item.method === req.method) { found = {item, params: item.names.reduce((p, name, i) => { p[name] = match[i + 1]; return p; }, {})}; break; }
      methods.push(item.method);
    }
    if (!found) throw methods.length ? new ApiError(405, 'Use ' + methods.join(' or ') + ' for ' + urlPath) : new ApiError(404, 'No such endpoint; GET /api lists them');
    const query = {};
    url.searchParams.forEach((value, key) => { query[key] = value; });
    const ctx = {req, res, query, params: found.params, jsonBody: (required) => jsonBody(req, required),
      sendBytes: (status, data, kind) => sendBytes(res, status, data, kind)};
    const result = await found.item.handler(ctx);
    if (result !== undefined) sendJson(res, 200, result);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    if (error instanceof ApiError) return sendJson(res, error.status, {error: error.message}, error.status === 401 ? {'WWW-Authenticate': 'Bearer'} : undefined);
    log('internal error: ' + (error && error.stack));
    return sendJson(res, 500, {error: 'Internal server error; see ' + LOG_PATH});
  }
  return undefined;
}

function main() {
  firstBoot();
  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('error', (error) => { log('cannot listen on ' + LISTEN_HOST + ':' + LISTEN_PORT + ': ' + error.message); console.error(error.message); process.exit(1); });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    const address = server.address();
    log('listening on ' + address.address + ':' + address.port);
    console.log('webos-foundry tv-server listening on http://' + address.address + ':' + address.port);
  });
  const stop = () => { if (live.active) live.active.kill('SIGTERM'); server.close(); setTimeout(() => process.exit(0), 200).unref(); };
  process.on('uncaughtException', (error) => log('uncaught: ' + error.stack)); // no supervisor on the TV: stay up
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main();
