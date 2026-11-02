'use strict';
// Homebrew app management, run by dispatch.sh on the TV.
//   node apps.js list                    removable apps as a JSON array [{id,title,icon,version,removable}]
//   node apps.js install <b64 {url, sha256?}>   download the IPK with curl, then sideload it (webOS dev installer)
//   node apps.js uninstall <b64 app id>         remove a sideloaded app
// Success: one JSON line on stdout (list: one JSON array). Failure: message on stderr, exit 1 (bad input: exit 3).
// Install mechanism is `luna://com.webos.appInstallService/dev/{install,remove}` with `{id, ipkUrl, subscribe:
// true}` (install) / `{id, subscribe: true}` (remove), streamed via `luna-send -i` until a line carries
// `"state":"installed"`/`"removed"` or `"errorText"`. This is the exact call this project's own earlier
// overlay installer already proved works on this TV — `ipkUrl` there is a local filesystem path the TV reads
// directly, not a network fetch, so an http(s) URL from the caller is downloaded
// here with `curl` to a private temp file first (and sha256-checked if a hash was given) before the same
// proven local-install call is made. `org.webosbrew.hbchannel.service` was never actually exercised this way
// this session; this file no longer calls it.
const {spawn, spawnSync} = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALLER = 'luna://com.webos.appInstallService/dev/';
const LIST = 'luna://com.webos.applicationManager/listApps';
const TIMEOUT_MS = Number(process.env.WOF_APPS_TIMEOUT_MS) || 90000;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.WOF_APPS_DOWNLOAD_TIMEOUT_MS) || 60000;
const MAX_IPK_BYTES = 64 * 1024 * 1024;
const URL_RE = /^https?:\/\/[^\s"'\\`<>]+$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function fail(message, code) {
  console.error(message);
  process.exit(code || 1);
}

function decode(b64) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64 || '')) fail('Payload is not base64', 3);
  return Buffer.from(b64, 'base64').toString('utf8');
}

function installRequest(b64) {
  let req;
  try { req = JSON.parse(decode(b64)); } catch (e) { fail('Malformed install request', 3); }
  if (!req || typeof req !== 'object' || Array.isArray(req) || Object.keys(req).some((k) => k !== 'url' && k !== 'sha256')) {
    fail('Install request must be {"url", "sha256"?}', 3);
  }
  if (typeof req.url !== 'string' || req.url.length > 500 || !URL_RE.test(req.url)) fail('Invalid IPK URL', 3);
  if (req.sha256 !== undefined && (typeof req.sha256 !== 'string' || !SHA_RE.test(req.sha256))) fail('Invalid sha256', 3);
  return req;
}

// Downloads `url` to a private temp file with curl (present on this TV per docs/FINDINGS.md), checks `sha256`
// if given, and returns the local path. Caller deletes it, success or failure.
function download(url, sha256) {
  const dest = path.join(os.tmpdir(), 'webos-foundry-app-' + crypto.randomBytes(8).toString('hex') + '.ipk');
  const r = spawnSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time',
      String(Math.floor(DOWNLOAD_TIMEOUT_MS / 1000)), '--output', dest, '--', url],
    {timeout: DOWNLOAD_TIMEOUT_MS + 2000, stdio: ['ignore', 'ignore', 'pipe']});
  if (r.error || r.status !== 0) {
    try { fs.unlinkSync(dest); } catch (e) {}
    fail('Download failed: ' + (r.stderr ? r.stderr.toString().trim().slice(0, 200) : 'curl error'));
  }
  let stat;
  try { stat = fs.statSync(dest); } catch (e) { fail('Downloaded file is missing'); }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IPK_BYTES) {
    try { fs.unlinkSync(dest); } catch (e) {}
    fail('Downloaded file is empty or too large');
  }
  if (sha256) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (digest !== sha256) {
      try { fs.unlinkSync(dest); } catch (e) {}
      fail('Downloaded file does not match the given sha256');
    }
  }
  return dest;
}

// Streams a subscription until a terminal line: an `errorText`, or `state` equal to `wantState`. Resolves with
// that line, or the last line seen when luna-send exits first; rejects on timeout.
function stream(method, payload, wantState, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('luna-send', ['-w', String(TIMEOUT_MS), '-i', INSTALLER + method,
      JSON.stringify({...payload, subscribe: true})], {stdio: ['ignore', 'pipe', 'ignore']});
    let buf = '';
    let last = null;
    let settled = false;
    const end = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.kill();
      fn(value);
    };
    const timer = setTimeout(() => end(reject, new Error(label + ' timed out')), TIMEOUT_MS);
    const take = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      last = msg;
      if (msg.errorText || msg.state === wantState) end(resolve, msg);
    };
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        take(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.on('error', (e) => end(reject, new Error('luna-send failed: ' + e.message)));
    child.on('close', () => { take(buf); end(resolve, last); });
  });
}

function report(msg, what, wantState) {
  if (!msg) fail(what + ' ended without a result');
  if (msg.errorText) {
    console.log(JSON.stringify(msg));
    fail(what + ' failed: ' + msg.errorText);
  }
  if (msg.state !== wantState) fail(what + ' ended without finishing: ' + JSON.stringify(msg));
  console.log(JSON.stringify(msg));
}

function list() {
  const r = spawnSync('luna-send', ['-n', '1', '-w', '5000', LIST, '{}'],
    {encoding: 'utf8', timeout: 6000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  if (r.error || r.status !== 0) fail('TV service did not answer: ' + LIST);
  let reply;
  try { reply = JSON.parse(r.stdout); } catch (e) { fail('TV service returned malformed data: ' + LIST); }
  if (!reply || reply.returnValue !== true || !Array.isArray(reply.apps)) fail(LIST + ': ' + r.stdout.slice(0, 200));
  // Heuristic (no dedicated "list Homebrew apps" call is known): system apps are not removable, installed ones are.
  console.log(JSON.stringify(reply.apps.filter((a) => a && a.removable === true).map((a) => (
    {id: a.id, title: a.title, icon: a.icon, version: a.version, removable: true}))));
}

async function install(arg) {
  const req = installRequest(arg);
  const local = download(req.url, req.sha256);
  try {
    const msg = await stream('install', {id: 'com.ares.defaultName', ipkUrl: local}, 'installed', 'install');
    report(msg, 'install', 'installed');
  } finally {
    try { fs.unlinkSync(local); } catch (e) {}
  }
}

async function main() {
  const [verb, arg] = process.argv.slice(2);
  try {
    if (verb === 'list') list();
    else if (verb === 'install') await install(arg);
    else if (verb === 'uninstall') {
      const id = decode(arg);
      if (!ID_RE.test(id)) fail('Invalid app id', 3);
      report(await stream('remove', {id}, 'removed', 'uninstall'), 'uninstall', 'removed');
    } else fail('usage: apps.js list | install <base64> | uninstall <base64>', 3);
  } catch (e) { fail(e.message); }
}

main();
