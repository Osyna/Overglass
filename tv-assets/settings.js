'use strict';
// AI picture/sound settings, run by dispatch.sh under the TV.
//   node settings.js list                                        all SETTINGS as a JSON array
//   node settings.js set <category> <key> <base64 {value, context}>   checked write with readback
// Success: one JSON value on stdout (set: the result message string). Failure: message on stderr, exit 3.
const {spawnSync} = require('child_process');

const S = 'luna://com.webos.service.settings/';
// Only these settings can ever be read or written: [category, key, label].
const SETTINGS = [
  ['aiPicture', 'ai_Picture', 'AI Picture Pro'],
  ['aiPicture', 'ai_Brightness', 'AI Brightness'],
  ['aiPicture', 'ai_Genre', 'AI Genre'],
  ['picture', 'superResolution', 'Super Resolution'],
  ['sound', 'soundMode', 'Sound Mode'],
  ['sound', 'aiSound', 'AI Sound'],
  ['sound', 'clearVoice', 'Clear Voice'],
  ['sound', 'aigamesound', 'AI Game Sound'],
];

function luna(uri, payload) {
  const r = spawnSync('luna-send', ['-n', '1', '-w', '3000', uri, JSON.stringify(payload)],
    {encoding: 'utf8', timeout: 3500, stdio: ['ignore', 'pipe', 'pipe']});
  if (r.error || r.status !== 0) throw new Error('TV service did not answer: ' + uri);
  let reply;
  try { reply = JSON.parse(r.stdout); } catch (e) { throw new Error('TV service returned malformed data: ' + uri); }
  if (reply.returnValue !== true) throw new Error(uri + ': ' + JSON.stringify(reply));
  return reply;
}
const norm = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

function describe(pairs) {
  const out = [];
  for (const category of [...new Set(pairs.map((p) => p[0]))]) {
    const keys = pairs.filter((p) => p[0] === category).map((p) => p[1]);
    const desc = luna(S + 'getSystemSettingDesc', {category, keys}).results;
    const cur = luna(S + 'getSystemSettings', {category, keys});
    if (!Array.isArray(desc) || !cur.settings || !cur.dimension) throw new Error('TV returned malformed ' + category + ' settings');
    for (const key of keys) {
      const d = desc.find((r) => r.key === key);
      if (!d || !(key in cur.settings)) throw new Error('TV does not report ' + category + '.' + key);
      const values = (((d.values || {}).arrayExt) || [])
        .filter((v) => v.active === true && v.visible === true && typeof v.value === 'string').map((v) => v.value);
      const ui = d.ui || {};
      if (!Array.isArray(d.dimension)) throw new Error('TV omitted scope for ' + key);
      const context = {};
      for (const axis of d.dimension) {
        if (typeof axis !== 'string' || !(axis in cur.dimension)) throw new Error('TV omitted context axis for ' + key);
        context[axis] = cur.dimension[axis];
      }
      out.push({category, key, value: cur.settings[key], values,
        available: ui.active === true && ui.visible === true && values.length > 0, context});
    }
  }
  return out;
}

function list() {
  const labels = new Map(SETTINGS.map(([c, k, l]) => [c + '\0' + k, l]));
  return describe(SETTINGS.map(([c, k]) => [c, k]))
    .map((item) => ({...item, label: labels.get(item.category + '\0' + item.key)}));
}

function request(b64) {
  let doc;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('not base64');
    doc = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) { throw new Error('Setting request must be base64 JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Setting request must be a JSON object');
  const {value, context} = doc;
  if (typeof value !== 'string' || !value) throw new Error('Setting value must be a non-empty string');
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      !Object.values(context).every((v) => typeof v === 'string')) {
    throw new Error('Setting context must be the context object returned by the settings list');
  }
  return {value, context};
}

function set(category, key, b64) {
  const entry = SETTINGS.find(([c, k]) => c === category && k === key);
  if (!entry) throw new Error('Unsupported setting');
  const {value, context} = request(b64), pair = [[category, key]];
  const before = describe(pair)[0];
  if (norm(before.context) !== norm(context)) throw new Error('TV input/mode changed since the list was read; refresh and retry');
  if (!before.available) throw new Error(category + '.' + key + ' is unavailable in the current TV context');
  if (!before.values.includes(value)) throw new Error(JSON.stringify(value) + ' is not allowed for ' + key + ' here');
  luna(S + 'setSystemSettings', {category, settings: {[key]: value}});
  const after = describe(pair)[0];
  if (after.value !== value || norm(after.context) !== norm(context)) {
    throw new Error('TV readback mismatch after setting ' + key + ': now ' + JSON.stringify(after.value));
  }
  return key + ' = ' + value + ' (persists on the TV until changed)';
}

try {
  const [mode, category, key, b64] = process.argv.slice(2);
  let result;
  if (mode === 'list' && process.argv.length === 3) result = list();
  else if (mode === 'set' && process.argv.length === 6) result = set(category, key, b64);
  else throw new Error('Usage: list | set <category> <key> <base64 JSON {value, context}>');
  console.log(JSON.stringify(result));
} catch (e) { console.error(e.message); process.exit(3); }
