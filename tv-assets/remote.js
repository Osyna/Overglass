'use strict';
// Remote keys, HDMI switch, volume/mute and power off, run by dispatch.sh under the TV.
//   node remote.js <action> [value]      value is the HDMI input 1-4 and only valid for "hdmi"
// Success: the result message as a JSON string on stdout. Failure: message on stderr, exit 3.
const {spawnSync} = require('child_process');

const AU = 'luna://com.webos.service.audio/master/';
const AM = 'luna://com.webos.applicationManager/', PW = 'luna://com.webos.service.tvpower/power/';
const NI = 'luna://com.webos.service.networkinput/';
const KEYS = {home: 'HOME', back: 'BACK', up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', ok: 'ENTER'};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function luna(uri, payload, allowEmpty = false) {
  const r = spawnSync('luna-send', ['-n', '1', '-w', '3000', uri, JSON.stringify(payload)],
    {encoding: 'utf8', timeout: 3500, stdio: ['ignore', 'pipe', 'pipe']});
  if (r.error || r.status !== 0) throw new Error('TV service did not answer: ' + uri);
  if (allowEmpty && !r.stdout.trim()) return null;
  let reply;
  try { reply = JSON.parse(r.stdout); } catch (e) { throw new Error('TV service returned malformed data: ' + uri); }
  if (reply.returnValue !== true) throw new Error(uri + ': ' + JSON.stringify(reply));
  return reply;
}
function until(test, message, ms) {
  let last = '';
  const end = Date.now() + ms;
  for (;;) {
    try { if (test()) return; } catch (e) { last = ': ' + e.message; }
    if (Date.now() >= end) throw new Error(message + last);
    sleep(200);
  }
}
function vol() {
  const v = luna(AU + 'getVolume', {}).volumeStatus;
  if (!v || !Number.isInteger(v.volume) || !Number.isInteger(v.maxVolume) || typeof v.muteStatus !== 'boolean') {
    throw new Error('TV returned malformed volume status');
  }
  if (v.soundOutput !== 'tv_speaker') {
    throw new Error('Volume control needs TV speaker output; current output is ' + v.soundOutput);
  }
  return v;
}
const fg = () => luna(AM + 'getForegroundAppInfo', {}).appId;
const shown = (v) => 'Volume ' + v.volume + (v.muteStatus ? ' (muted)' : '');

function remote(a, value) {
  if (Object.prototype.hasOwnProperty.call(KEYS, a)) {
    luna(NI + 'sendSpecialKey', {key: KEYS[a]});
    if (a === 'home') until(() => fg() === 'com.webos.app.home', 'TV did not report Home after the key', 5000);
    return 'Sent ' + a;
  }
  if (a === 'hdmi') {
    if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error('HDMI input must be 1-4');
    const id = 'com.webos.app.hdmi' + value;
    luna(AM + 'launch', {id});
    until(() => fg() === id, 'TV did not switch to HDMI ' + value, 8000);
    return 'Switched to HDMI ' + value;
  }
  if (a === 'power_off') {
    // powerOff can close its call without a reply; the standby readback below is mandatory.
    luna(PW + 'powerOff', {reason: 'remoteKey'}, true);
    until(() => ['Active Standby', 'ActiveStandby'].includes(luna(PW + 'getPowerState', {}).state),
      'TV did not enter standby', 10000);
    return 'TV is in standby';
  }
  const v = vol();
  if (a === 'volume_up' || a === 'volume_down') {
    const target = Math.max(0, Math.min(v.maxVolume, v.volume + (a === 'volume_up' ? 1 : -1)));
    if (target !== v.volume) luna(AU + 'setVolume', {soundOutput: 'tv_speaker', volume: target});
    const n = vol();
    if (n.volume !== target) throw new Error('TV volume readback mismatch: ' + n.volume);
    return shown(n);  // setVolume may unmute on the TV; report the real state.
  }
  if (a === 'mute' || a === 'unmute') {
    const want = a === 'mute';
    luna(AU + 'muteVolume', {soundOutput: 'tv_speaker', mute: want});
    const n = vol();
    if (n.muteStatus !== want) throw new Error('TV mute readback mismatch');
    return shown(n);
  }
  throw new Error('Unsupported remote action');
}

try {
  const [action, text] = process.argv.slice(2);
  if (!action || process.argv.length > 4) throw new Error('Usage: <action> [value]');
  if (text !== undefined && !(action === 'hdmi' && /^[1-4]$/.test(text))) throw new Error('This remote action takes no value');
  console.log(JSON.stringify(remote(action, text === undefined ? undefined : Number(text))));
} catch (e) { console.error(e.message); process.exit(3); }
