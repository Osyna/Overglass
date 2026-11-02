'use strict';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const ACTIVE = new Set(['running', 'cancelling', 'restoring', 'release_unconfirmed']);
const SOURCE_CHANGING = new Set(['wake', 'power_off', 'hdmi', 'home', 'back']);
const CATEGORY = { aiPicture: 'AI picture', picture: 'Picture', sound: 'Sound' };
const JOB_STATE = {
  running: ['Processing', 'busy'], cancelling: ['Cancelling', 'busy'], restoring: ['Restoring the TV', 'busy'],
  release_unconfirmed: ['Release unconfirmed', 'error'], done: ['Done', 'ok'], failed: ['Failed', 'error'],
  cancelled: ['Cancelled', 'error'],
};
const LIMIT = { image: 16 * 1048576, audio: 8 * 1048576 };
const TOKEN_KEY = 'webos-foundry-token';
const VIEWS = new Set(['home', 'remote', 'apps', 'show', 'tune', 'settings', 'api']);

const S = {
  view: 'home', api: null, status: null, statusError: null, statusBusy: false, statusAgain: false,
  settings: null, settingsBusy: false, settingsAgain: false, settingNote: null,
  job: null, jobTimer: null, reserved: false, file: null, kind: null, logPolls: false, wakeUntil: 0,
  detailsBusy: false, detailsAgain: false, details: null, historyOpen: false, notifyBusy: false, shotBusy: false, shotUrl: null,
  overlayBusy: false, live: null, liveCooling: false, zoom: null,
  paired: null, token: '', statusUnauthorized: false, promptDismissed: false, resultFor: null, resultUrl: null,
  authMode: null, bannerDismissed: false,
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}
function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
const pretty = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const bytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : Math.max(1, Math.round(n / 1024)) + ' KiB');
const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");

/* ---------- API client and request log ---------- */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function call(method, path, opts = {}) {
  const init = { method, headers: {} };
  if (S.token) init.headers.Authorization = 'Bearer ' + S.token;
  let shown;
  if (opts.file) {
    init.body = opts.file;
    init.headers['Content-Type'] = 'application/octet-stream';
    shown = `<${opts.file.name}: ${bytes(opts.file.size)} of file bytes>`;
  } else if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers['Content-Type'] = 'application/json';
    shown = opts.json;
  }
  const started = performance.now();
  let status = 0;
  let data;
  let blob;
  try {
    const res = await fetch(path, init);
    status = res.status;
    const type = res.headers.get('Content-Type') || '';
    if (res.ok && (type.startsWith('image/') || type.startsWith('audio/'))) {
      blob = await res.blob();
      data = { [type.split('/')[0]]: `${type}, ${bytes(blob.size)}` };
    } else {
      data = type.startsWith('application/json') ? await res.json() : { error: `Unexpected ${type || 'empty'} response` };
    }
  } catch (err) {
    data = { error: 'The server is not reachable (' + err.message + ')' };
  }
  if (!opts.poll || S.logPolls) {
    addLog({ method, path, status, ms: Math.round(performance.now() - started), shown, data,
      json: opts.json, file: opts.file && opts.file.name });
  }
  if (status === 401) unauthorized((data && data.error) || 'token rejected');
  if (status >= 200 && status < 300) return blob || data;
  throw new ApiError(status, (data && data.error) || `HTTP ${status}`);
}

async function openStream(path, signal) {
  const started = performance.now();
  const logged = (status, data) => addLog({ method: 'GET', path, status, ms: Math.round(performance.now() - started), data });
  let res;
  try {
    res = await fetch(path, { signal, headers: S.token ? { Authorization: 'Bearer ' + S.token } : {} });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    logged(0, { error: 'The server is not reachable (' + err.message + ')' });
    throw new ApiError(0, 'The server is not reachable (' + err.message + ')');
  }
  if (!res.ok || !(res.headers.get('Content-Type') || '').startsWith('application/octet-stream')) {
    const data = (res.headers.get('Content-Type') || '').startsWith('application/json') ? await res.json() : { error: `HTTP ${res.status}` };
    logged(res.status, data);
    if (res.status === 401) unauthorized(data.error || 'token rejected');
    throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  }
  logged(res.status, { stream: 'WOF1 header, then raw RGB frames until stopped' });
  return res;
}

function curl({ method, path, json, file }) {
  const parts = ['curl', '-sS'];
  if (method !== 'GET') parts.push('-X', method);
  parts.push(shellQuote(location.origin + path));
  if (S.token) parts.push('-H', '"Authorization: Bearer $WOF_TOKEN"');  // the real token never reaches the clipboard
  if (file) parts.push('-H', shellQuote('Content-Type: application/octet-stream'), '--data-binary', shellQuote('@' + file));
  else if (json !== undefined) parts.push('-H', shellQuote('Content-Type: application/json'), '-d', shellQuote(JSON.stringify(json)));
  return parts.join(' ');
}

/* ---------- what this server can do (GET /api is the source of truth) ---------- */

// Before the catalogue loads, or if it cannot be read, assume everything is there; the calls then report their own errors.
function supports({ group, route }) {
  if (!S.api) return true;
  return S.api.routes.some((r) => (!group || r.group === group) && (!route || r.path === route));
}

// Any panel that names a group or route the server does not list is greyed out and labelled, never left as a dead control.
function applyAvailability() {
  for (const panel of document.querySelectorAll('[data-needs-group], [data-needs-route]')) {
    const ok = (!panel.dataset.needsGroup || supports({ group: panel.dataset.needsGroup }))
      && (!panel.dataset.needsRoute || supports({ route: panel.dataset.needsRoute }));
    const head = panel.querySelector(':scope > .panel-head');
    panel.dataset.unavailable = String(!ok);
    for (const child of panel.children) child.inert = !ok && child !== head;
    for (const btn of head.querySelectorAll('button')) btn.inert = !ok;
    const badge = head.querySelector('.badge');
    if (!ok && !badge) head.append(h('span', { class: 'badge', text: 'Not available from this server' }));
    if (ok && badge) badge.remove();
  }
  // A remote action the server's catalogue does not list (the on-TV server cannot wake itself) is hidden, not left to fail.
  const remoteRoute = S.api && S.api.routes.find((r) => r.path === '/api/remote/{action}');
  const actions = remoteRoute && remoteRoute.values ? new Set(remoteRoute.values.map((v) => v.name)) : null;
  for (const btn of document.querySelectorAll('[data-action]')) btn.hidden = !!actions && !actions.has(btn.dataset.action);
}

const tvLabel = (host) => (!host ? 'Not paired' : /^(127\.|::1$|localhost$)/.test(host) ? 'Running on the TV itself' : host);

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const box = h('textarea', { class: 'sr', readonly: true, 'aria-hidden': 'true' });  // a phone on plain-HTTP LAN has no clipboard API
  box.value = text;
  document.body.append(box);
  box.select();
  const copied = document.execCommand('copy');
  box.remove();
  if (!copied) throw new Error('copy blocked');
  return undefined;
}

/* ---------- token ---------- */

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

function saveToken(value, remember = true) {
  S.token = value;
  S.promptDismissed = false;
  S.statusUnauthorized = false;
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    if (value) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value);
  } catch { /* storage blocked: the token lasts until the page is reloaded */ }
  renderDevice();
}

function renderDevice() {
  let saved = false;
  try { saved = !!localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  $('device-state').textContent = !S.token
    ? 'No token is saved here. That is fine if login is off, or if this page runs on the computer that hosts the server.'
    : saved ? 'A token is saved on this device.' : 'A token is kept for this browser tab only.';
}

function openToken(reason) {
  const dialog = $('token-dialog');
  if (reason) {
    result($('token-msg'), S.token ? 'That token was not accepted. Check it and try again.' : 'Enter your access token to continue.',
      S.token ? 'error' : undefined);
  } else {
    $('token-msg').hidden = true;
  }
  $('token-clear').hidden = !S.token;
  if (!dialog.open) { $('token-input').value = ''; dialog.showModal(); }
  $('token-input').focus();
}

function unauthorized(reason) {
  if (!S.promptDismissed) openToken(reason);
  else say('Sign-in needed (' + reason + '). Open Settings and choose Change token.', 'error');
}

async function loadResult(job) {
  if (S.resultFor === job.id) return;
  S.resultFor = job.id;
  try {
    const blob = await call('GET', job.result);  // fetched with the token: a plain href or src could not send it
    if (!S.job || S.job.id !== job.id) return;
    if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
    S.resultUrl = URL.createObjectURL(blob);
    const download = $('job-download');
    download.href = S.resultUrl;
    download.download = job.name + '-' + job.profile + (job.kind === 'image' ? '.png' : '.wav');
    download.hidden = false;
    $('job-preview').replaceChildren(job.kind === 'image'
      ? h('img', { src: S.resultUrl, alt: 'Processed 4K result of ' + job.name })
      : h('audio', { src: S.resultUrl, controls: true, preload: 'metadata' }));
  } catch (err) {
    S.resultFor = null;
    say('Could not load the result: ' + err.message, 'error');
  }
}

function copyButton(label, text) {
  const span = h('span', { text: label });
  const btn = h('button', { class: 'btn quiet', type: 'button' }, icon('copy'), span);
  btn.addEventListener('click', async () => {
    try {
      await copyText(text());
      span.textContent = 'Copied';
    } catch {
      span.textContent = 'Copy failed';
    }
    setTimeout(() => { span.textContent = label; }, 1400);
  });
  return btn;
}

function addLog(e) {
  const tone = e.status >= 200 && e.status < 300 ? 'ok' : 'error';
  const entry = h('li', { class: 'entry' }, h('details', {},
    h('summary', {},
      h('span', { class: `m m-${e.method}`, text: e.method }),
      h('span', { class: 'path', text: e.path, title: e.path }),
      h('span', { class: 'code num', dataset: { tone }, text: e.status || 'ERR' }),
      h('span', { class: 'ms num', text: e.ms + ' ms' })),
    h('div', { class: 'entry-body' },
      e.shown !== undefined && [h('h4', { text: 'Request body' }), h('pre', { text: pretty(e.shown) })],
      h('h4', { text: 'Response' }), h('pre', { text: pretty(e.data) }),
      h('div', {}, copyButton('Copy as curl', () => curl(e))))));
  const list = $('log-list');
  list.prepend(entry);
  while (list.children.length > 80) list.lastElementChild.remove();
  $('log-empty').hidden = true;
}

/* ---------- notices and button feedback ---------- */

let noticeTimer;
function say(text, tone = 'info') {
  const el = $('notice');
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, tone === 'error' ? 12000 : 6000);
}

function flash(el, state) {
  el.dataset.state = state;
  clearTimeout(el._flash);
  el._flash = setTimeout(() => { delete el.dataset.state; }, 1200);
}

/* ---------- status ---------- */

async function loadStatus(poll = false) {
  if (S.paired === false) return renderStatus();
  if (S.statusBusy) { S.statusAgain = true; return; }
  S.statusBusy = true;
  try {
    S.status = await call('GET', '/api/status', { poll });
    S.statusError = null;
    S.statusUnauthorized = false;
  } catch (err) {
    S.statusError = err.message;
    S.statusUnauthorized = err.status === 401;
  } finally {
    S.statusBusy = false;
    renderStatus();
  }
  if (S.statusAgain) { S.statusAgain = false; await loadStatus(poll); }
}

function renderStatus() {
  const st = S.statusError ? null : S.status;
  const state = S.statusError ? 'error' : (st ? st.power : 'unknown');
  document.querySelector('.status .power').dataset.power = state;
  $('st-power').textContent = S.statusUnauthorized ? 'Sign in needed' : S.paired === false ? 'Not paired' : S.statusError ? 'Unreachable'
    : !st ? '—' : { on: 'On', off: 'Standby' }[st.power] || 'Unknown';
  $('st-power').title = S.statusError || (st && st.raw_power_state) || '';
  $('st-source').textContent = st && st.source ? st.source : '—';
  $('st-source').title = st && st.app_id ? st.app_id : '';
  $('st-temp').textContent = st && st.temperature_c != null ? st.temperature_c.toFixed(1) + ' °C' : '—';
  $('st-volume').textContent = !st || st.volume == null ? '—' : st.volume + (st.muted ? ' · muted' : '');
  $('volume-level').textContent = st && st.volume != null ? st.volume : '—';

  $('hero-line').textContent = S.paired === false ? 'Not connected to a TV yet'
    : S.statusUnauthorized ? 'Sign in to control your TV'
      : S.statusError ? 'Can’t reach your TV'
        : !st ? 'Checking your TV…'
          : { on: 'Your TV is on', off: 'Your TV is in standby' }[st.power] || 'Your TV is in an unknown state';
  $('hero-orb').dataset.power = state;
  $('hero-orb').dataset.waking = String(S.wakeUntil > Date.now() && state !== 'on');
  $('hero-signin').hidden = !S.statusUnauthorized;
  document.body.dataset.paired = String(S.paired !== false);
  document.querySelector('.hero-actions [data-action="wake"]').classList.toggle('primary', state !== 'on');
  $('top-pill').dataset.power = state;
  $('top-power').textContent = S.statusUnauthorized ? 'Sign in' : S.paired === false ? 'Not paired' : S.statusError ? 'Offline'
    : !st ? 'Checking…' : { on: 'On', off: 'Standby' }[st.power] || 'Unknown';

  for (const seg of document.querySelectorAll('.seg')) {
    const current = !!st && st.power === 'on' && (seg.dataset.action === 'home'
      ? st.is_luma === true : st.source === 'HDMI ' + seg.dataset.value);
    seg.setAttribute('aria-pressed', String(current));
  }
  const mute = $('mute');
  const muted = !!st && st.muted === true;
  mute.setAttribute('aria-pressed', String(muted));
  mute.dataset.action = muted ? 'unmute' : 'mute';
  mute.replaceChildren(icon(muted ? 'muted' : 'speaker'), h('span', { text: muted ? 'Unmute' : 'Mute' }));
  if (S.statusError && S.paired !== false && !S.statusUnauthorized) say('TV status unavailable: ' + S.statusError, 'error');
  sync();
}

/* ---------- control availability ---------- */

function sync() {
  const off = !!S.status && !S.statusError && S.status.power === 'off';
  for (const btn of document.querySelectorAll('[data-action]')) {
    btn.disabled = S.reserved || S.paired === false || (off && btn.hasAttribute('data-needs-on'));
  }
  $('remote-hint').textContent = S.reserved ? 'Reserved by processing' : off ? 'In standby: turn the TV on first' : '';
  for (const el of document.querySelectorAll('#settings-body select, #settings-body button')) {
    if (S.reserved) el.disabled = true;
  }
  $('refresh-settings').disabled = S.reserved;
  $('start').disabled = !S.file || S.reserved;
  $('file').disabled = S.reserved;
  $('profile').disabled = S.reserved;
  syncNotify();
}

/* ---------- remote ---------- */

async function remote(btn) {
  const action = btn.dataset.action;
  const value = btn.dataset.value ? Number(btn.dataset.value) : undefined;
  btn.dataset.state = 'loading';
  try {
    const result = await call('POST', '/api/remote/' + action, value === undefined ? {} : { json: { value } });
    flash(btn, 'ok');
    if (action === 'wake') {
      say(result.message + '. Watching for the TV to turn on…');
      watchWake();
    }
  } catch (err) {
    flash(btn, 'error');
    say(`${btn.getAttribute('aria-label') || btn.textContent.trim()}: ${err.message}`, 'error');
  }
  await loadStatus();
  if (SOURCE_CHANGING.has(action) && action !== 'wake') { loadSettings(); loadDetails(); }
}

async function watchWake() {
  S.wakeUntil = Date.now() + 40000;
  while (Date.now() < S.wakeUntil) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await loadStatus(true);
    if (S.status && !S.statusError && S.status.power === 'on') {
      S.wakeUntil = 0;
      say('The TV is on.');
      loadSettings();
      loadDetails();
      return;
    }
  }
  if (S.wakeUntil) say('The TV did not report power on within 40 s. It must be in network standby to wake.', 'error');
}

/* ---------- settings ---------- */

function settingsMessage(text, tone, retry) {
  $('settings-body').replaceChildren(h('p', { class: 'empty', dataset: tone ? { tone } : {}, text },
    retry && [' ', h('button', { class: 'btn quiet', type: 'button', onclick: loadSettings, text: 'Try again' })]));
}

async function loadSettings() {
  if (!supports({ group: 'Picture & sound' })) return;
  if (S.paired === false) return settingsMessage('Not paired with a TV yet.');
  if (S.reserved) return settingsMessage('The TV is reserved by a processing job. Settings reload when it is released.');
  if (S.status && !S.statusError && S.status.power === 'off') return settingsMessage('The TV is in standby. Turn it on to read its settings.');
  if (S.settingsBusy) { S.settingsAgain = true; return; }
  S.settingsBusy = true;
  $('refresh-settings').dataset.state = 'loading';
  if (!S.settings) settingsMessage('Reading settings from the TV…');
  try {
    S.settings = await call('GET', '/api/settings');
    renderSettings();
  } catch (err) {
    S.settings = null;
    settingsMessage('Could not read settings: ' + err.message, 'error', true);
  } finally {
    S.settingsBusy = false;
    delete $('refresh-settings').dataset.state;
  }
  if (S.settingsAgain) { S.settingsAgain = false; loadSettings(); }
}

function renderSettings() {
  const groups = new Map();
  for (const item of S.settings) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const body = [];
  for (const [category, items] of groups) {
    body.push(h('div', { class: 'set-group' }, h('h3', { text: CATEGORY[category] || category }), items.map(settingRow)));
  }
  $('settings-body').replaceChildren(...body);
  if (!S.settings.length) settingsMessage('The TV reported no settings.');
  sync();
}

function settingRow(item) {
  const id = item.category + '.' + item.key;
  const select = h('select', { 'aria-label': item.label, disabled: !item.available });
  const values = item.values.includes(item.value) ? item.values : [item.value, ...item.values];
  for (const value of values) select.append(h('option', { value, text: value, disabled: !item.values.includes(value) }));
  select.value = item.value;
  const apply = h('button', { class: 'btn', type: 'button', text: 'Apply', disabled: true });
  const msg = h('p', { class: 'set-msg', hidden: true });
  select.addEventListener('change', () => { apply.disabled = select.value === item.value; });
  apply.addEventListener('click', () => applySetting(item, select, apply, msg));
  const scope = Object.entries(item.context).map(([k, v]) => `${k} ${v}`).join(' · ');
  const scopeText = (item.available ? '' : 'Not available for this input and mode. ')
    + (scope ? 'Scope: ' + scope : 'Global setting');
  const note = S.settingNote && S.settingNote.id === id ? S.settingNote : null;
  if (note) { msg.hidden = false; msg.textContent = note.text; msg.dataset.tone = note.tone; }
  return h('div', { class: 'set-row', dataset: { available: String(item.available) } },
    h('div', { class: 'set-name' }, h('strong', { text: item.label }), h('code', { text: id })),
    select, apply, h('p', { class: 'set-scope', text: scopeText }), msg);
}

async function applySetting(item, select, apply, msg) {
  apply.dataset.state = 'loading';
  apply.disabled = true;
  select.disabled = true;
  try {
    const result = await call('PUT', `/api/settings/${encodeURIComponent(item.category)}/${encodeURIComponent(item.key)}`,
      { json: { value: select.value, context: item.context } });
    S.settingNote = { id: item.category + '.' + item.key, text: result.message, tone: 'ok' };
    setTimeout(() => { S.settingNote = null; }, 8000);
    await loadSettings();
  } catch (err) {
    delete apply.dataset.state;
    apply.disabled = false;
    select.disabled = false;
    msg.hidden = false;
    msg.dataset.tone = 'error';
    msg.textContent = err.message;
    if (/changed since/.test(err.message)) {  // input or picture mode moved: show the new scope, keep the reason
      S.settingNote = { id: item.category + '.' + item.key, text: err.message, tone: 'error' };
      loadSettings();
    }
  }
}

/* ---------- file processing ---------- */

function kindOf(file) {
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g)$/.test(name) || /^image\/(png|jpeg)$/.test(file.type)) return 'image';
  if (/\.wav$/.test(name) || /^audio\/(x-)?wav/.test(file.type)) return 'audio';
  return null;
}

function pickFile(file) {
  if (!file) return;
  const kind = kindOf(file);
  $('drop-main').textContent = file.name;
  S.file = null;
  if (!kind) {
    $('drop-sub').textContent = 'Not supported: choose a PNG, JPEG or WAV file';
  } else if (file.size > LIMIT[kind]) {
    $('drop-sub').textContent = `Too large: ${bytes(file.size)}; ${kind === 'image' ? 'images' : 'WAV files'} must be at most ${bytes(LIMIT[kind])}`;
  } else {
    S.file = file;
    S.kind = kind;
    $('drop-sub').textContent = `${kind === 'image' ? 'Image' : 'Audio'} · ${bytes(file.size)} · choose another file to replace it`;
    const spec = S.api && S.api.kinds[kind];
    if (spec) {
      $('profile').replaceChildren(...spec.profiles.map((p) => h('option', { value: p.id, text: p.label })));
      $('limits').textContent = spec.limits;
    }
  }
  $('profile-field').hidden = !S.file;
  $('limits').hidden = !S.file;
  sync();
}

async function startJob(event) {
  event.preventDefault();
  if (!S.file || S.reserved) return;
  const query = new URLSearchParams({ profile: $('profile').value, name: S.file.name });
  $('start').dataset.state = 'loading';
  try {
    showJob(await call('POST', '/api/jobs?' + query, { file: S.file }));
  } catch (err) {
    say('Processing did not start: ' + err.message, 'error');
  } finally {
    delete $('start').dataset.state;
    sync();
  }
}

function showJob(job) {
  const wasReserved = S.reserved;
  S.job = job;
  S.reserved = ACTIVE.has(job.state);
  renderJob();
  sync();
  clearTimeout(S.jobTimer);
  if (S.reserved) S.jobTimer = setTimeout(pollJob, 1000);
  else if (wasReserved) { loadStatus(); loadSettings(); }
}

async function pollJob() {
  if (!S.job) return;
  try {
    showJob(await call('GET', '/api/jobs/' + S.job.id, { poll: true }));
  } catch (err) {
    say('Lost track of the job: ' + err.message, 'error');
    S.jobTimer = setTimeout(pollJob, 3000);
  }
}

function jobMessage(job) {
  const recovery = job.recovery_workspace ? ` The TV kept recovery files in ${job.recovery_workspace}; check its picture and sound settings.` : '';
  const lastLine = (job.log || '').trim().split('\n').filter(Boolean).pop() || '';
  switch (job.state) {
    case 'running': return job.kind === 'image'
      ? 'The image is on the TV screen while it is processed. Remote and settings are locked until the TV is restored.'
      : 'Playing through the sound engine with the speakers muted. Remote and settings are locked until the TV is restored.';
    case 'cancelling': return 'Cancelling. The processor stops at its next step; the TV is put back the way it was before the job ends.';
    case 'restoring': return 'Waiting for the TV-side process to restore the TV and release it.';
    case 'release_unconfirmed': return `Could not confirm that the TV was released: ${sentence(job.release_error)} Remote and settings stay locked. Check the TV, then check its release again.${recovery}`;
    case 'done': return `${job.kind === 'image' ? '3840×2160 PNG' : '32-bit WAV'} ready. The TV settings were restored.`;
    case 'cancelled': return 'Cancelled; no result was saved.' + recovery;
    default: return (lastLine ? sentence(lastLine) : 'Processing failed.') + recovery;
  }
}

const sentence = (text) => text.trim().replace(/[.\s]*$/, '.');

function renderJob() {
  const job = S.job;
  $('job').hidden = !job;
  if (!job) return;
  const [label, tone] = JOB_STATE[job.state] || [job.state, 'busy'];
  $('job-title').textContent = job.name + ' · ' + job.profile;
  $('job-state').textContent = label;
  $('job-state').dataset.tone = tone;
  $('job-msg').textContent = jobMessage(job);
  $('job-cancel').hidden = job.state !== 'running';
  $('job-release').hidden = job.state !== 'release_unconfirmed';
  const download = $('job-download');
  const preview = $('job-preview');
  if (job.result) {
    loadResult(job);
  } else {
    S.resultFor = null;
    download.hidden = true;
    download.removeAttribute('href');
    preview.replaceChildren();
  }
  const log = $('job-log');
  if (log.textContent !== (job.log || '')) {
    log.textContent = job.log || '';
    log.scrollTop = log.scrollHeight;
  }
  renderElapsed();
}

function renderElapsed() {
  const job = S.job;
  if (!job) return;
  const end = job.finished || Date.now() / 1000;
  const s = Math.max(0, Math.round(end - job.created));
  $('job-elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function jobAction(path, btn) {
  btn.dataset.state = 'loading';
  btn.disabled = true;
  try {
    showJob(await call('POST', `/api/jobs/${S.job.id}/${path}`));
  } catch (err) {
    say(err.message, 'error');
  } finally {
    delete btn.dataset.state;
    btn.disabled = false;
  }
}

/* ---------- TV details ---------- */

const APP_NAMES = {
  'com.ecklf.luma': 'Luma', 'com.webos.app.home': 'LG Home', 'com.webos.app.screensaver': 'Screen saver',
  'com.webos.app.tvsimpleviewer': 'TV viewer', 'com.webos.app.mediadiscovery': 'Media discovery',
};
const num = (n) => n.toLocaleString('en-US');

function words(code) {
  const text = String(code).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function appName(id) {
  const hdmi = /^com\.webos\.app\.hdmi(\d)$/.exec(id);
  return hdmi ? 'HDMI ' + hdmi[1] : APP_NAMES[id] || words(id.split('.').pop());
}

function duration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '<1 min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return minutes + ' min';
  return rest ? `${hours} h ${rest} min` : hours + ' h';
}

function signalText(s) {
  const parts = [];
  if (s.width != null && s.height != null) parts.push(`${s.width}×${s.height}`);
  if (s.fps != null) parts.push(Math.round(s.fps) + ' Hz');
  if (s.hdr && s.hdr !== 'none') parts.push(s.hdr.toUpperCase());
  if (s.vrr) parts.push('VRR');
  if (s.allm) parts.push('ALLM');
  if (s.pixel_encoding) parts.push(s.pixel_encoding);
  const mode = [s.timing, s.game_mode && 'Game'].filter(Boolean).join('/');
  if (mode) parts.push(mode);
  return parts.join(' · ') || null;
}

const none = (text = 'Not reported') => h('span', { class: 'none', text });

function panelText(d) {
  return [d.panel_hours != null && num(d.panel_hours) + ' h', d.panel_temperature_c != null && d.panel_temperature_c + ' °C']
    .filter(Boolean).join(' · ');
}

function renderDetails() {
  const d = S.details;
  const rows = [];
  const add = (term, value) => rows.push(h('dt', { text: term }), h('dd', {}, value || none()));
  const since = (runs, last) => `${runs} ${runs === 1 ? 'run' : 'runs'}` + (last == null ? ''
    : d.panel_hours == null ? `, last at ${num(last)} h` : `, ${num(Math.max(0, d.panel_hours - last))} h since the last`);
  const panel = panelText(d);
  const refresher = d.pixel_refresher;
  const history = d.power_history && d.power_history.length ? h('details', { class: 'mini', open: S.historyOpen,
    ontoggle: (e) => { S.historyOpen = e.currentTarget.open; } },
  h('summary', { text: 'Recent power events' }),
  h('ul', { class: 'rows' }, d.power_history.map((e) => h('li', {},
    h('span', { title: e.reason, text: words(e.reason) }),
    h('span', { class: 'num', text: e.panel_hours == null ? '—' : 'at ' + num(e.panel_hours) + ' h' }))))) : null;
  const usage = d.usage_today && d.usage_today.length
    ? h('ul', { class: 'rows' }, d.usage_today.map((u) => h('li', {},
      h('span', { title: u.app_id, text: appName(u.app_id) }),
      h('span', { class: 'num', text: duration(u.seconds) + (u.launches == null ? '' : ` · ${u.launches} ${u.launches === 1 ? 'launch' : 'launches'}`) }))))
    : d.usage_today ? none('No usage recorded today') : null;

  add('Ambient light', d.lux != null && h('span', { class: 'num', text: d.lux + ' lx' }));
  add('OLED panel', panel && h('span', { class: 'num', text: panel }));
  add('Pixel refresher', refresher && [
    h('span', { class: 'num', text: 'Full: ' + since(refresher.full_runs, refresher.full_last_panel_hours) }),
    h('span', { class: 'sub num', text: 'Standby: ' + since(refresher.standby_runs, refresher.standby_last_panel_hours) })]);
  add('Signal', d.signal && signalText(d.signal) && h('span', { class: 'num', title: d.signal.app_id || '', text: signalText(d.signal) }));
  add('Sleep timer', d.sleep_timer && words(d.sleep_timer));
  add('Powered on by', d.power_on_reason && [h('span', { title: d.power_on_reason, text: words(d.power_on_reason) }), history]);
  add('Usage today', usage);
  $('details-body').replaceChildren(h('dl', { class: 'facts' }, rows));
}

function detailsMessage(text, tone, retry) {
  $('details-body').replaceChildren(h('p', { class: 'empty', dataset: tone ? { tone } : {}, text },
    retry && [' ', h('button', { class: 'btn quiet', type: 'button', onclick: () => loadDetails(), text: 'Try again' })]));
}

async function loadDetails(poll = false) {
  if (!supports({ route: '/api/details' })) return;
  if (S.paired === false) return detailsMessage('Not paired with a TV yet.');
  if (S.status && !S.statusError && S.status.power === 'off') {
    S.details = null;
    return detailsMessage('The TV is in standby. Turn it on to read its details.');
  }
  if (S.detailsBusy) { S.detailsAgain = true; return; }
  S.detailsBusy = true;
  $('refresh-details').dataset.state = 'loading';
  if (!S.details) detailsMessage('Reading details from the TV…');
  try {
    S.details = await call('GET', '/api/details', { poll });
    renderDetails();
  } catch (err) {
    S.details = null;
    detailsMessage('Could not read details: ' + err.message, 'error', true);
  } finally {
    S.detailsBusy = false;
    delete $('refresh-details').dataset.state;
  }
  if (S.detailsAgain) { S.detailsAgain = false; loadDetails(poll); }
}

/* ---------- notify and screenshot ---------- */

function result(el, text, tone) {
  el.textContent = text;
  if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
  el.hidden = false;
}

function syncNotify() {
  const off = !!S.status && !S.statusError && S.status.power === 'off';
  const empty = !$('notify-text').value.trim();
  $('toast').disabled = empty || off || S.notifyBusy;
  $('speak').disabled = empty || off || S.notifyBusy || S.reserved;
  $('notify-hint').textContent = off ? 'In standby: turn the TV on first' : S.reserved ? 'Reading aloud waits for processing' : '';
  $('shot-capture').disabled = off || S.shotBusy;
  syncOverlay(off);
  syncLive(off);
}

async function sendNotify(kind, btn) {
  const msg = $('notify-msg');
  const json = { message: $('notify-text').value.trim() };
  if (kind === 'say') json.volume = Number($('notify-volume').value);
  S.notifyBusy = true;
  syncNotify();
  btn.dataset.state = 'loading';
  if (kind === 'say') result(msg, `Speaking at volume ${json.volume}…`);
  try {
    result(msg, (await call('POST', '/api/notify/' + kind, { json })).message, 'ok');
    flash(btn, 'ok');
  } catch (err) {
    result(msg, err.message, 'error');
    flash(btn, 'error');
  }
  S.notifyBusy = false;
  syncNotify();
  if (kind === 'say') loadStatus();
}

async function capture() {
  const btn = $('shot-capture');
  const msg = $('shot-msg');
  const width = Number($('shot-width').value);
  S.shotBusy = true;
  syncNotify();
  btn.dataset.state = 'loading';
  result(msg, 'Capturing…');
  try {
    const blob = await call('GET', `/api/screenshot?width=${width}&format=jpg`);
    if (!(blob instanceof Blob)) throw new Error('The server did not return an image');
    if (S.shotUrl) URL.revokeObjectURL(S.shotUrl);
    S.shotUrl = URL.createObjectURL(blob);
    const now = new Date();
    $('shot-view').replaceChildren(h('img', { src: S.shotUrl, alt: 'Screenshot of the TV picture' }),
      h('figcaption', { class: 'hint', text: `${width} × ${width * 9 / 16} · ${bytes(blob.size)} · ${now.toLocaleTimeString()}` }));
    const link = $('shot-download');
    link.href = S.shotUrl;
    link.download = `tv-screenshot-${width}-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
    link.hidden = false;
    $('shot-view').hidden = false;
    msg.hidden = true;
    flash(btn, 'ok');
  } catch (err) {
    result(msg, 'Capture failed: ' + err.message, 'error');
    flash(btn, 'error');
  }
  S.shotBusy = false;
  syncNotify();
}

/* ---------- on-screen card ---------- */

function cardFromForm() {
  const card = { kind: $('ov-kind').value, position: $('ov-position').value };
  const title = $('ov-title').value.trim();
  const body = $('ov-body').value.trim();
  const lines = $('ov-lines').value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (title) card.title = title;
  if (body) card.body = body;
  if (lines.length) card.lines = lines;
  const seconds = $('ov-seconds').value.trim();
  if (seconds !== '') card.seconds = Number(seconds);
  return card;
}

function syncOverlay(off) {
  const card = cardFromForm();
  const blocked = off || S.reserved || S.overlayBusy;
  $('ov-show').disabled = blocked || !(card.title || card.body || card.lines);
  $('ov-hide').disabled = blocked;
  $('ov-details').disabled = blocked;
  $('overlay-hint').textContent = off ? 'In standby: turn the TV on first' : S.reserved ? 'Reserved by processing' : '';
}

async function sendOverlay(card, btn) {
  const msg = $('overlay-msg');
  if (card.seconds !== undefined && !(Number.isInteger(card.seconds) && card.seconds >= 0 && card.seconds <= 300)) {
    return result(msg, 'Seconds must be a whole number from 0 to 300', 'error');
  }
  S.overlayBusy = true;
  syncNotify();
  btn.dataset.state = 'loading';
  try {
    result(msg, (await call('POST', '/api/overlay', { json: card })).message, 'ok');
    flash(btn, 'ok');
  } catch (err) {
    result(msg, err.message, 'error');
    flash(btn, 'error');
  }
  S.overlayBusy = false;
  syncNotify();
}

async function showDetailsCard(btn) {
  if (!S.details) await loadDetails();
  const d = S.details;
  const lines = [];
  if (d && d.signal && signalText(d.signal)) lines.push('Signal: ' + signalText(d.signal));
  if (d && panelText(d)) lines.push('OLED panel: ' + panelText(d));
  if (d && d.lux != null) lines.push('Ambient light: ' + d.lux + ' lx');
  for (const u of (d && d.usage_today) || []) {
    if (/^com\.webos\.app\.hdmi\d$/.test(u.app_id)) lines.push(`${appName(u.app_id)} today: ${duration(u.seconds)}`);
  }
  if (!lines.length) return result($('overlay-msg'), 'The TV reported no details to show', 'error');
  await sendOverlay({ title: 'TV details', lines, kind: 'info', position: $('ov-position').value, seconds: 15 }, btn);
}

/* ---------- live view ---------- */

const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function edgeColors(rgb, w, h) {
  const bw = Math.max(1, Math.round(w * 0.1));
  const bh = Math.max(1, Math.round(h * 0.1));
  const average = (x0, x1, y0, y1) => {
    const sum = [0, 0, 0];
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = (y * w + x0) * 3; x < x1; x++, i += 3) { sum[0] += rgb[i]; sum[1] += rgb[i + 1]; sum[2] += rgb[i + 2]; }
    }
    const n = (x1 - x0) * (y1 - y0);
    return sum.map((v) => v / n);
  };
  return { top: average(0, w, 0, bh), bottom: average(0, w, h - bh, h), left: average(0, bw, 0, h), right: average(w - bw, w, 0, h) };
}

function joinBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function syncLive(off) {
  if (off === undefined) off = !!S.status && !S.statusError && S.status.power === 'off';
  $('live-start').disabled = off || S.reserved || !!S.live || S.liveCooling;
  $('live-start').hidden = !!S.live;
  $('live-stop').hidden = !S.live;
  $('live-size').disabled = $('live-fps').disabled = !!S.live;
}

function paintLive(live, rgb) {
  const px = live.img.data;
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { px[j] = rgb[i]; px[j + 1] = rgb[i + 1]; px[j + 2] = rgb[i + 2]; px[j + 3] = 255; }
  live.ctx.putImageData(live.img, 0, 0);
  const now = performance.now();
  if (now - live.edgeAt >= 250) {
    live.edgeAt = now;
    for (const [edge, color] of Object.entries(edgeColors(rgb, live.w, live.h))) {
      $('chip-' + edge).style.backgroundColor = `rgb(${color.map(Math.round).join(',')})`;
      $('hex-' + edge).textContent = hex(color);
    }
  }
  if (now - live.statAt >= 500) {
    $('live-stats').textContent = `${(((live.frames - live.statFrames) * 1000) / (now - live.statAt)).toFixed(1)} fps · ${live.frames} frames`;
    live.statAt = now;
    live.statFrames = live.frames;
  }
}

async function pumpLive(live, reader) {
  let buf = new Uint8Array(0);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf = buf.length ? joinBytes(buf, value) : value;
    if (!size) {
      if (buf.length < 8) continue;
      if (String.fromCharCode(...buf.subarray(0, 4)) !== 'WOF1') throw new Error('The stream has an unexpected header');
      const head = new DataView(buf.buffer, buf.byteOffset, 8);
      live.w = head.getUint16(4, true);
      live.h = head.getUint16(6, true);
      size = live.w * live.h * 3;
      const canvas = $('live-canvas');
      canvas.width = live.w;
      canvas.height = live.h;
      live.ctx = canvas.getContext('2d');
      live.img = live.ctx.createImageData(live.w, live.h);
      live.started = live.statAt = performance.now();
      buf = buf.subarray(8);
    }
    let newest = null;  // draw only the newest frame of a burst
    while (buf.length >= size) { newest = buf.subarray(0, size); buf = buf.subarray(size); live.frames++; }
    if (newest) paintLive(live, newest);
  }
}

async function startLive() {
  if (S.live) return;
  const [width, height] = $('live-size').value.split('x').map(Number);
  const live = { ctl: new AbortController(), frames: 0, statFrames: 0, edgeAt: 0, w: 0, h: 0 };
  S.live = live;
  syncLive();
  result($('live-msg'), 'Starting…');
  $('live-stats').textContent = '';
  try {
    const res = await openStream(`/api/screen/stream?width=${width}&height=${height}&fps=${$('live-fps').value}`, live.ctl.signal);
    $('live-view').hidden = false;
    $('live-msg').hidden = true;
    await pumpLive(live, res.body.getReader());
    result($('live-msg'), 'The stream ended (time limit or the TV stopped it).');
  } catch (err) {
    if (err.name === 'AbortError') $('live-msg').hidden = true;
    else result($('live-msg'), err.message, 'error');
  } finally {
    if (live.frames) {
      $('live-stats').textContent = `${((live.frames * 1000) / (performance.now() - live.started)).toFixed(1)} fps average · ${live.frames} frames`;
    }
    S.live = null;
    if (live.ctl.signal.aborted) {  // the server needs a moment to stop the TV-side client
      S.liveCooling = true;
      setTimeout(() => { S.liveCooling = false; syncLive(); }, 2500);
    }
    syncLive();
  }
}

function stopLive() {
  if (S.live) S.live.ctl.abort();
}

/* ---------- zoom lightbox ---------- */

function openZoom(el, reparent) {
  S.zoom = { scale: 1, x: 0, y: 0, reparent: reparent ? { el, parent: el.parentNode, next: el.nextSibling } : null };
  el.style.transform = '';
  $('zoom-stage').replaceChildren(el);
  $('zoom-view').showModal();
}

function applyZoom() {
  const z = S.zoom, el = $('zoom-stage').firstElementChild;
  if (z && el) el.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.scale})`;
}

function wireZoom() {
  const dialog = $('zoom-view');
  const stage = $('zoom-stage');
  const openShot = () => { const img = $('shot-view').querySelector('img'); if (img) openZoom(img.cloneNode(), false); };
  const openLive = () => openZoom($('live-canvas'), true);
  const onKey = (open) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  $('live-canvas').addEventListener('click', openLive);
  $('live-canvas').addEventListener('keydown', onKey(openLive));
  $('shot-view').addEventListener('click', openShot);
  $('shot-view').addEventListener('keydown', onKey(openShot));
  $('zoom-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    const z = S.zoom;
    if (z && z.reparent) z.reparent.parent.insertBefore(z.reparent.el, z.reparent.next);
    S.zoom = null;
  });
  stage.addEventListener('dblclick', () => {
    const z = S.zoom;
    if (!z) return;
    Object.assign(z, z.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2 });
    applyZoom();
  });
  stage.addEventListener('wheel', (e) => {
    const z = S.zoom;
    if (!z) return;
    e.preventDefault();
    z.scale = Math.min(6, Math.max(1, z.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    if (z.scale === 1) { z.x = 0; z.y = 0; }
    applyZoom();
  }, { passive: false });

  const pointers = new Map();
  let pinch = null, pan = null;  // pinch: {dist, scale}; pan: {x, y, startX, startY}
  const pointDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const z = S.zoom;
    if (!z) return;
    if (pointers.size === 2) { pinch = { dist: pointDist(...pointers.values()), scale: z.scale }; pan = null; }
    else if (pointers.size === 1 && z.scale > 1) { pan = { x: e.clientX, y: e.clientY, startX: z.x, startY: z.y }; stage.dataset.panning = 'true'; }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const z = S.zoom;
    if (!z) return;
    if (pointers.size === 2 && pinch) {
      z.scale = Math.min(6, Math.max(1, pinch.scale * (pointDist(...pointers.values()) / pinch.dist)));
      if (z.scale === 1) { z.x = 0; z.y = 0; }
      applyZoom();
    } else if (pan) {
      z.x = pan.startX + (e.clientX - pan.x);
      z.y = pan.startY + (e.clientY - pan.y);
      applyZoom();
    }
  });
  const releasePointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { pan = null; delete stage.dataset.panning; }
  };
  stage.addEventListener('pointerup', releasePointer);
  stage.addEventListener('pointercancel', releasePointer);
}

/* ---------- API reference ---------- */

function renderApi() {
  const api = S.api;
  if (S.paired !== false) $('tv-addr').textContent = api.tv && api.tv.address ? tvLabel(api.tv.address) : '—';
  const kinds = Object.entries(api.kinds || {}).map(([kind, spec]) =>
    h('li', {}, h('strong', { text: kind + ': ' }), spec.profiles.map((p, i) => [i ? ', ' : '', h('code', { text: p.id })])));
  $('api-intro').replaceChildren(
    h('h2', { text: 'HTTP API' }),
    h('p', { text: `Everything in this app goes through these routes, so anything you can tap you can script. Base URL ${api.base}; JSON in and out, except file uploads and downloads.` }),
    h('p', { text: api.errors }),
    h('p', { text: 'The server answers on its configured address. Send the server token as Authorization: Bearer <token> on every route except GET /api and GET /api/health; a loopback server accepts requests without one. Requests from other websites are refused by Host, Origin and Sec-Fetch-Site checks.' }),
    h('dl', {},
      h('dt', { text: 'TV' }), h('dd', {}, h('code', { text: (api.tv && api.tv.address) || 'Not paired' })),
      h('dt', { text: 'Profiles' }), h('dd', {}, h('ul', { class: 'plain' }, kinds)),
      h('dt', { text: 'Catalogue' }), h('dd', {}, h('code', { text: 'GET /api' }), ' returns this page as JSON')));

  const groups = new Map();
  for (const route of api.routes) {
    if (!groups.has(route.group)) groups.set(route.group, []);
    groups.get(route.group).push(route);
  }
  $('api-routes').replaceChildren(...[...groups].map(([group, routes]) =>
    h('section', { class: 'api-group' }, h('h2', { text: group }), routes.map(routeCard))));
}

function routeCard(route) {
  const rows = [];
  const add = (term, ...value) => rows.push(h('dt', { text: term }), h('dd', {}, ...value));
  if (route.query) add('Query', h('ul', {}, Object.entries(route.query).map(([k, v]) => h('li', {}, h('code', { text: k }), ' — ' + v))));
  if (route.body) add('Body', route.body);
  if (route.returns) add('Returns', h('code', { text: route.returns }));
  if (route.tv && route.tv.length) add('On the TV', h('ul', {}, route.tv.map((t) => h('li', {}, h('code', { text: t })))));
  if (route.notes) add('Notes', route.notes);

  let values = null;
  if (route.values) {
    const withTv = route.values.some((v) => v.tv);
    values = h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: withTv ? 'Action' : 'Setting' }), h('th', { text: 'Meaning' }), withTv && h('th', { text: 'On the TV' }))),
      h('tbody', {}, route.values.map((v) => h('tr', {},
        h('td', {}, h('code', { text: v.name })), h('td', { text: v.detail }), withTv && h('td', {}, h('code', { text: v.tv }))))));
  }

  const ex = route.example || { path: route.path };
  const command = curl({ method: route.method, path: ex.path, json: ex.body, file: ex.upload });
  const tryable = route.method === 'GET' && !route.stream && !/[{}]|JOB_ID/.test(ex.path);
  const output = h('pre', { hidden: true });
  const send = tryable && h('button', { class: 'btn', type: 'button', text: 'Send request' });
  if (send) {
    send.addEventListener('click', async () => {
      send.dataset.state = 'loading';
      try {
        const reply = await call('GET', ex.path);
        output.textContent = reply instanceof Blob ? `${reply.type}, ${bytes(reply.size)}` : pretty(reply);
      } catch (err) {
        output.textContent = `${err.status || 'ERR'}: ${err.message}`;
      }
      output.hidden = false;
      delete send.dataset.state;
    });
  }
  return h('article', { class: 'route', id: 'route-' + route.method + route.path.replace(/\W+/g, '-') },
    h('div', { class: 'route-head' }, h('span', { class: `m m-${route.method}`, text: route.method }), h('code', { text: route.path })),
    h('p', { text: route.summary }),
    rows.length && h('dl', {}, rows),
    values,
    h('div', { class: 'curl' }, h('pre', { text: command }), copyButtonIcon(() => command)),
    send && h('div', { class: 'row' }, send),
    output);
}

function copyButtonIcon(text) {
  const btn = h('button', { class: 'btn icon-only', type: 'button', 'aria-label': 'Copy curl command', title: 'Copy' }, icon('copy'));
  btn.addEventListener('click', async () => {
    try { await copyText(text()); flash(btn, 'ok'); } catch { flash(btn, 'error'); }
  });
  return btn;
}

/* ---------- views, keyboard, startup ---------- */

function showView(view) {
  if (!VIEWS.has(view)) view = 'home';
  S.view = view;
  for (const el of document.querySelectorAll('.view')) el.hidden = el.dataset.viewId !== view;
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (view !== 'show') stopLive();  // the live picture is private: it must not keep streaming into a hidden page
  if (view === 'apps' && S.api) loadApps();
  if (location.hash !== '#' + view) history.replaceState(null, '', view === 'home' ? location.pathname : '#' + view);
  window.scrollTo(0, 0);
}

function renderTheme() {
  const chosen = savedTheme();
  for (const btn of document.querySelectorAll('[data-theme-choice]')) btn.setAttribute('aria-pressed', String(btn.dataset.themeChoice === chosen));
}

const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Backspace: 'back', h: 'home', H: 'home' };
document.addEventListener('keydown', (event) => {
  if (!['home', 'remote'].includes(S.view) || event.altKey || event.ctrlKey || event.metaKey) return;
  if (document.querySelector('dialog[open]')) return;
  const target = event.target;
  if (target.closest('input, select, textarea, [contenteditable], summary')) return;
  let action = KEYS[event.key];
  if (event.key === 'Enter' && !target.closest('button, a')) action = 'ok';
  if (!action) return;
  const btn = document.querySelector(`.remote .key[data-action="${action}"], .remote .row [data-action="${action}"]`);
  if (!btn || btn.disabled) return;
  event.preventDefault();
  remote(btn);
});

/* ---------- pairing (connects this server to a TV, from the browser) ---------- */

let pairKey = '';  // kept out of S and the shared call() logger: never shown, never sent anywhere but POST /api/pair

function syncPairForm() {
  $('pair-go').disabled = !$('pair-host').value.trim() || !pairKey.trim();
}

async function pickPairKey(file) {
  if (!file) return;
  const drop = $('pair-drop');
  pairKey = '';
  delete drop.dataset.ready;
  $('pair-drop-main').textContent = file.name;
  if (file.size > 16384) {
    $('pair-drop-sub').textContent = 'That is too large to be a private key. Choose another file.';
  } else {
    const text = await file.text();
    if (!text.trim()) {
      $('pair-drop-sub').textContent = 'That file is empty. Choose another one.';
    } else {
      pairKey = text;
      drop.dataset.ready = 'true';
      $('pair-drop-sub').textContent = 'Key loaded · choose another file to replace it';
    }
  }
  syncPairForm();
}

async function submitPair(e) {
  e.preventDefault();
  const btn = $('pair-go');
  const msg = $('pair-msg');
  const host = $('pair-host').value.trim();
  btn.disabled = true;
  btn.dataset.state = 'loading';
  result(msg, 'Connecting…');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    const res = await fetch('/api/pair', { method: 'POST', headers, body: JSON.stringify({ host, key: pairKey }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    pairKey = '';
    $('pair-key-text').value = '';
    $('pair-file').value = '';
    result(msg, data.message, 'ok');
    S.paired = true;
    $('tv-addr').textContent = tvLabel(data.tv_host);
    $('pair-hint').hidden = true;
    loadAll();
  } catch (err) {
    result(msg, err.message, 'error');
    delete btn.dataset.state;
    syncPairForm();
  }
}

function wire() {
  $('token-btn').addEventListener('click', () => { S.promptDismissed = false; openToken(); });
  $('pair-host').addEventListener('input', syncPairForm);
  $('pair-file').addEventListener('change', (e) => pickPairKey(e.target.files[0]));
  $('pair-key-text').addEventListener('input', (e) => { pairKey = e.target.value; syncPairForm(); });
  $('pair-form').addEventListener('submit', submitPair);
  { const drop = $('pair-drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.dataset.over = 'true'; });
    drop.addEventListener('dragleave', () => { delete drop.dataset.over; });
    drop.addEventListener('drop', (e) => { e.preventDefault(); delete drop.dataset.over; pickPairKey(e.dataTransfer.files[0]); }); }
  $('hero-signin').addEventListener('click', () => { S.promptDismissed = false; openToken(); });
  $('token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('token-input').value.trim();
    if (!value) return result($('token-msg'), 'Enter a token, or choose Forget saved token to send none', 'error');
    saveToken(value, $('token-remember').checked);
    $('token-dialog').close();
    loadAll();
  });
  $('token-clear').addEventListener('click', () => { saveToken(''); $('token-dialog').close(); loadAll(); });
  $('token-cancel').addEventListener('click', () => { S.promptDismissed = true; $('token-dialog').close(); });
  $('token-dialog').addEventListener('cancel', () => { S.promptDismissed = true; });
  for (const btn of document.querySelectorAll('[data-action]')) btn.addEventListener('click', () => remote(btn));
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showView(tab.dataset.view));
  for (const link of document.querySelectorAll('[data-goto]')) link.addEventListener('click', () => showView(link.dataset.goto));
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      try { await copyText(btn.dataset.copy); flash(btn, 'ok'); } catch { flash(btn, 'error'); }
    });
  }
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.addEventListener('click', () => { applyTheme(btn.dataset.themeChoice); renderTheme(); });
  }
  $('theme-toggle').addEventListener('click', () => { applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'); renderTheme(); });
  $('refresh-status').addEventListener('click', () => loadStatus());
  $('refresh-settings').addEventListener('click', loadSettings);
  $('log-polls').addEventListener('change', (e) => { S.logPolls = e.target.checked; });
  $('log-clear').addEventListener('click', () => { $('log-list').replaceChildren(); $('log-empty').hidden = false; });
  $('file').addEventListener('change', (e) => pickFile(e.target.files[0]));
  $('job-form').addEventListener('submit', startJob);
  $('job-cancel').addEventListener('click', (e) => jobAction('cancel', e.currentTarget));
  $('job-release').addEventListener('click', (e) => jobAction('release', e.currentTarget));
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); if (!S.reserved) drop.dataset.over = 'true'; });
  drop.addEventListener('dragleave', () => { delete drop.dataset.over; });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    delete drop.dataset.over;
    if (!S.reserved) pickFile(e.dataTransfer.files[0]);
  });
  setInterval(() => { if (!document.hidden && !S.statusBusy) loadStatus(true); }, 10000);
  setInterval(() => { if (S.job && ACTIVE.has(S.job.state)) renderElapsed(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopLive(); else loadStatus(true); });
  setInterval(() => { if (!document.hidden) loadDetails(true); }, 60000);
  $('refresh-details').addEventListener('click', () => loadDetails());
  $('notify-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('toast').disabled) sendNotify('toast', $('toast')); });
  $('speak').addEventListener('click', (e) => sendNotify('say', e.currentTarget));
  $('notify-text').addEventListener('input', syncNotify);
  $('notify-volume').addEventListener('input', (e) => { $('notify-volume-out').textContent = e.target.value; });
  $('shot-capture').addEventListener('click', capture);
  $('live-start').addEventListener('click', startLive);
  $('live-stop').addEventListener('click', stopLive);
  window.addEventListener('pagehide', stopLive);
  $('overlay-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('ov-show').disabled) sendOverlay(cardFromForm(), $('ov-show')); });
  $('ov-hide').addEventListener('click', (e) => sendOverlay({ hide: true }, e.currentTarget));
  $('ov-details').addEventListener('click', (e) => showDetailsCard(e.currentTarget));
  for (const id of ['ov-title', 'ov-body', 'ov-lines']) $(id).addEventListener('input', syncNotify);
}

async function loadAll() {
  if (S.paired === false) { renderStatus(); loadSettings(); loadDetails(); loadAuth(); return; }
  if (supports({ route: '/api/jobs' })) {
    try {
      const jobs = await call('GET', '/api/jobs');
      const id = jobs.active || (jobs.jobs[0] && jobs.jobs[0].id);
      if (id) showJob(await call('GET', '/api/jobs/' + id));
    } catch (err) {
      if (err.status !== 401) say('Could not read processing jobs: ' + err.message, 'error');
    }
  }
  await loadStatus();
  loadSettings();
  loadDetails();
  loadApps();
  loadAuth();
}

async function start() {
  S.token = readToken();
  wire();
  wireExtras();
  renderTheme();
  renderDevice();
  showView(location.hash.slice(1));
  try {
    const health = await call('GET', '/api/health');
    S.paired = health.paired;
    $('tv-addr').textContent = tvLabel(health.paired && health.tv_host);
    $('pair-hint').hidden = health.paired;
  } catch (err) {
    say('Could not reach the server: ' + err.message, 'error');
  }
  try {
    S.api = await call('GET', '/api');
    applyAvailability();
    renderApi();
  } catch (err) {
    say('Could not load the API catalogue: ' + err.message, 'error');
  }
  await loadAll();
}

document.addEventListener('DOMContentLoaded', start);
