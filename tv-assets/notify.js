'use strict';
// On-screen toast, overlay card or spoken announcement, run by dispatch.sh.
//   node notify.js toast <base64 UTF-8 text>
//   node notify.js say <base64 UTF-8 text> [volume 1-40]
//   node notify.js overlay <base64 UTF-8 JSON card>   (see card() for the fields)
// "say" must run under the TV lock /tmp/webos-foundry.lock (dispatch.sh wraps it in flock). TTS only speaks while the
// Audio Guidance setting is on and follows the TV-speaker volume, so it borrows Audio Guidance, volume
// and mute, and restores and re-reads all three. Success: JSON on stdout. Failure: message on stderr, exit 3.
const {spawn, spawnSync} = require('child_process');

const AU = 'luna://com.webos.service.audio/master/';
const ST = 'luna://com.webos.service.settings/';
const TTS = 'luna://com.webos.service.tts/';
const PW = 'luna://com.webos.service.tvpower/power/';
const MAX_CHARS = 200;
const OVERLAY_APP = 'dev.webosfoundry.overlay';

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

// Overlay card: {title?, body?, lines?: [text], image?: http(s) URL, kind?: info|success|warning|alert,
// position?: top-left|top-right|bottom-left|bottom-right|center, seconds?: 0-300 (0 = until hidden)} or {hide: true}.
function card(b64) {
  let raw;
  try { raw = JSON.parse(utf8(b64, 6000)); } catch (e) { throw new Error('Overlay card must be base64 JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Overlay card must be a JSON object');
  const allowed = ['title', 'body', 'lines', 'image', 'kind', 'position', 'seconds', 'hide'];
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error('Unknown overlay field: ' + extra.join(', '));
  if (raw.hide !== undefined) {
    if (raw.hide !== true || Object.keys(raw).length !== 1) throw new Error('Use {"hide": true} alone to hide the overlay');
    return {hide: true};
  }
  const out = {};
  if (raw.title !== undefined) out.title = clean(raw.title, 80, 'title');
  if (raw.body !== undefined) out.body = clean(raw.body, 400, 'body');
  if (raw.lines !== undefined) {
    if (!Array.isArray(raw.lines) || raw.lines.length > 10) throw new Error('lines must be a list of at most 10 texts');
    out.lines = raw.lines.map((line) => clean(line, 120, 'Each line'));
  }
  if (raw.image !== undefined) {
    if (typeof raw.image !== 'string' || raw.image.length > 500 || !/^https?:\/\/[^\s"'<>]+$/.test(raw.image)) {
      throw new Error('image must be an http(s) URL of at most 500 characters');
    }
    out.image = raw.image;
  }
  for (const [key, values] of [['kind', ['info', 'success', 'warning', 'alert']],
    ['position', ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']]]) {
    if (raw[key] !== undefined) {
      if (!values.includes(raw[key])) throw new Error(key + ' must be one of ' + values.join(', '));
      out[key] = raw[key];
    }
  }
  if (raw.seconds !== undefined) {
    if (!Number.isInteger(raw.seconds) || raw.seconds < 0 || raw.seconds > 300) throw new Error('seconds must be an integer 0-300');
    out.seconds = raw.seconds;
  }
  if (!out.title && !out.body && !(out.lines && out.lines.length) && !out.image) throw new Error('An overlay card needs a title, body, lines or image');
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
  const [mode, b64, volumeArg] = argv;
  if (mode === 'toast' && argv.length === 2) return toast(decode(b64));
  if (mode === 'overlay' && argv.length === 2) return overlay(card(b64));
  if (mode === 'say' && (argv.length === 2 || argv.length === 3)) {
    const volume = argv.length === 3 ? Number(volumeArg) : 15;
    if (!Number.isInteger(volume) || volume < 1 || volume > 40) throw new Error('Volume must be an integer 1-40');
    return say(decode(b64), volume);
  }
  throw new Error('Usage: toast <base64> | say <base64> [volume 1-40] | overlay <base64 JSON>');
}

if (process.argv[2] === '--selftest') {
  const assert = require('assert');
  const b = (s) => Buffer.from(s, 'utf8').toString('base64');
  assert.strictEqual(decode(b('  Dîner prêt  ')), 'Dîner prêt');
  for (const bad of ['', 'not base64!', b(''), b('a\nb'), b('x'.repeat(201)), Buffer.from([0xff, 0xfe]).toString('base64')]) {
    assert.throws(() => decode(bad), bad);
  }
  const j = (o) => b(JSON.stringify(o));
  assert.deepStrictEqual(card(j({title: ' Door ', lines: ['a'], seconds: 0, kind: 'alert'})), {title: 'Door', lines: ['a'], seconds: 0, kind: 'alert'});
  assert.deepStrictEqual(card(j({hide: true})), {hide: true});
  for (const bad of [{}, {hide: true, title: 'x'}, {title: 'x', extra: 1}, {title: 'x'.repeat(81)}, {body: 'a\u0007'},
    {lines: 'x'}, {lines: Array(11).fill('x')}, {image: 'file:///etc/passwd'}, {image: 'javascript:alert(1)'},
    {title: 'x', kind: 'red'}, {title: 'x', seconds: 1.5}, {title: 'x', seconds: 301}, [1]]) {
    assert.throws(() => card(j(bad)), JSON.stringify(bad));
  }
  assert.throws(() => card(b('not json')));
  console.log('notify selftest ok');
} else {
  main(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => { console.error(error.message); process.exit(3); });
}
