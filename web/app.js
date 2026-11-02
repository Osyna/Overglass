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
const VIEWS = new Set(['home', 'remote', 'apps', 'automate', 'show', 'tune', 'settings', 'api']);

const S = {
  view: 'home', api: null, status: null, statusError: null, statusBusy: false, statusAgain: false,
  settings: null, settingsBusy: false, settingsAgain: false, settingNote: null,
  job: null, jobTimer: null, reserved: false, file: null, kind: null, logPolls: false, wakeUntil: 0,
  detailsBusy: false, detailsAgain: false, details: null, historyOpen: false, notifyBusy: false, shotBusy: false, shotUrl: null,
  overlayBusy: false, live: null, liveCooling: false, zoom: null,
  paired: null, token: '', statusUnauthorized: false, promptDismissed: false, resultFor: null, resultUrl: null,
  authMode: null, bannerDismissed: false,
  volumeBusy: false, volumeEditing: false,
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
  if (!opts.private && (!opts.poll || S.logPolls)) {
    addLog({ method, path, status, ms: Math.round(performance.now() - started), shown: studioRedact(shown), data: studioRedact(data),
      json: studioRedact(opts.json), file: opts.file && opts.file.name });
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
  studioStopEvents();
  studioApplyRole('');
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
    btn.disabled = btn.dataset.guestBlocked === 'true' || S.reserved || S.paired === false || (off && btn.hasAttribute('data-needs-on'));
  }
  syncRemoteVolume();
  $('remote-hint').textContent = S.reserved ? 'Reserved by processing' : off ? 'In standby: turn the TV on first' : '';
  for (const el of document.querySelectorAll('#settings-body select, #settings-body button')) {
    if (S.reserved) el.disabled = true;
  }
  $('refresh-settings').disabled = S.reserved;
  $('start').disabled = !S.file || S.reserved;
  $('file').disabled = S.reserved;
  $('profile').disabled = S.reserved;
  syncNotify();
  if (typeof syncApps === 'function') syncApps();
}

/* ---------- remote ---------- */

function remoteVolumeLimit() {
  return $('volume-unlock').checked ? 100 : 40;
}

function syncRemoteVolume() {
  const slider = $('remote-volume-slider'), cap = remoteVolumeLimit();
  const status = S.statusError ? null : S.status;
  const available = status?.power === 'on' && Number.isInteger(status.volume) && S.paired !== false;
  const action = S.api?.routes.find(route => route.path === '/api/remote/{action}');
  const supported = !action || !action.values || action.values.some(item => item.name === 'volume');
  const permitted = studioRole !== 'guest' || studioActions.includes('volume');
  const blocked = !available || S.reserved || S.volumeBusy;
  slider.disabled = blocked || !supported || !permitted;
  $('volume-unlock').disabled = blocked;
  slider.max = String(cap);
  if (!S.volumeEditing && !S.volumeBusy) slider.value = String(Math.min(available ? status.volume : 0, cap));
  else if (Number(slider.value) > cap) slider.value = String(cap);
  $('volume-target').textContent = available ? slider.value : '—';
  slider.setAttribute('aria-valuetext', available ? `Set volume to ${slider.value}` : 'Volume unavailable');
  $('volume-limit-hint').textContent = !supported ? 'Exact volume is not supported by this server.'
    : !permitted ? 'This account cannot set an exact volume. Use the permitted remote buttons.'
      : !available ? 'Turn on the TV and wait for its current volume.'
        : status.volume > cap ? `The TV is at ${status.volume}. Moving this slider sets a level up to ${cap}.`
          : cap === 40 ? 'Limited to 40. Check the box to unlock higher levels.'
            : 'Full range unlocked: 0–100. Higher levels can be loud.';
  for (const button of document.querySelectorAll('[data-action="volume_up"], [data-action="volume_down"], #mute')) {
    button.disabled = blocked || button.dataset.guestBlocked === 'true'
      || button.dataset.action === 'volume_up' && status.volume >= cap
      || button.dataset.action === 'volume_down' && status.volume <= 0;
  }
}

async function setRemoteVolume() {
  const slider = $('remote-volume-slider'), value = Number(slider.value);
  if (slider.disabled || S.volumeBusy) return;
  const restoreFocus = document.activeElement === slider;
  S.volumeEditing = false;
  if (!Number.isInteger(value) || value < 0 || value > remoteVolumeLimit()) { syncRemoteVolume(); return; }
  S.volumeBusy = true;
  syncRemoteVolume();
  result($('volume-send-msg'), `Setting volume to ${value}…`);
  try {
    const reply = await call('POST', '/api/remote/volume', { json: { value } });
    result($('volume-send-msg'), reply.message, 'ok');
  } catch (err) {
    result($('volume-send-msg'), 'Volume was not confirmed: ' + err.message, 'error');
  } finally {
    await loadStatus();
    S.volumeBusy = false;
    syncRemoteVolume();
    if (restoreFocus && document.activeElement === document.body && !slider.disabled) slider.focus({ preventScroll: true });
  }
}

function wireRemoteVolume() {
  const slider = $('remote-volume-slider');
  $('volume-unlock').checked = false;
  slider.addEventListener('input', () => {
    S.volumeEditing = true;
    slider.value = String(Math.max(0, Math.min(remoteVolumeLimit(), Number(slider.value))));
    syncRemoteVolume();
  });
  slider.addEventListener('change', setRemoteVolume);
  slider.addEventListener('blur', () => { if (!S.volumeBusy) { S.volumeEditing = false; syncRemoteVolume(); } });
  $('volume-unlock').addEventListener('change', () => { S.volumeEditing = false; sync(); });
}

async function remote(btn) {
  const action = btn.dataset.action;
  if (S.volumeBusy && ['volume_up', 'volume_down', 'mute', 'unmute'].includes(action)) return;
  if (action === 'volume_up' && S.status?.volume >= remoteVolumeLimit()) return;
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
  if (studioRole === 'guest') return;
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
  if (!S.job || studioRole === 'guest') return;
  try {
    const job = await call('GET', '/api/jobs/' + S.job.id, { poll: true });
    if (studioRole !== 'guest') showJob(job);
  } catch (err) {
    if (studioRole === 'guest') return;
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
  if (studioRole === 'guest') return;
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

/* ---------- card studio: the whole card (layout, look, widgets) as one draft, plus templates and saved designs ---------- */

const OVERLAY_TONES = ['info', 'success', 'warning', 'alert', 'accent'];
const OVERLAY_POSITIONS = {
  'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right',
  center: 'Centre', top: 'Top bar', bottom: 'Bottom bar', left: 'Left panel', right: 'Right panel',
};
const OVERLAY_SIZES = { xs: 'Extra small', s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large', full: 'Full' };
// The TV renderer's icon vocabulary (tv-assets/overlay/overlay.js ICONS): 24x24 stroke paths, copied verbatim.
const OVERLAY_ICONS = {
  ball: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5 3.5 2.6-1.3 4.1H9.8L8.5 10.6Z',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6l1-7Z',
  chart: 'M4 20h16M7 16v-5M12 16V7M17 16v-9',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M10 17h4v4',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
  pin: 'M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10Zm0-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-5v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  card: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
  swap: 'M7 4v12m0 0-3-3m3 3 3-3M17 20V8m0 0 3 3m-3-3-3 3',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5h0m0 3v5',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Zm4 4a2 2 0 0 0 4 0',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z',
  flag: 'M5 21V4m0 0h12l-3 4 3 4H5',
};
const OVERLAY_ICON_NAMES = ['', ...Object.keys(OVERLAY_ICONS)];
const OVERLAY_STATES = ['online', 'offline', 'degraded', 'unknown'];
const OVERLAY_FONTS = { sans: 'Sans', condensed: 'Condensed', mono: 'Mono' };
// label, TV default (shown while the colour is unset; an unset colour is left out of the JSON)
const OVERLAY_THEME_COLORS = { accent: ['Accent', '#84b5ec'], surface: ['Background', '#191c22'], text: ['Text', '#f0f2f5'],
  muted: ['Quiet text', '#c4c9d2'], line: ['Lines', '#3a3d43'] };
// label, min, max, step, TV default
const OVERLAY_THEME_RANGES = { opacity: ['Background opacity', 0.2, 1, 0.01, 0.94], radius: ['Corner radius', 0, 32, 1, 16],
  scale: ['Zoom', 0.75, 1.5, 0.05, 1] };
const OVERLAY_FIELDS = {
  stack: { gap: ['Spacing (TV pixels)', 0, 48, 1], align: ['Alignment', ['start', 'center', 'end']] },
  row: { gap: ['Spacing (TV pixels)', 0, 48, 1], align: ['Alignment', ['start', 'center', 'end']] },
  grid: { columns: ['Columns', 1, 3, 1], gap: ['Spacing (TV pixels)', 0, 48, 1] },
  ticker: { text: ['Scrolling text', 1000], speed: ['Speed (TV pixels per second)', 10, 200, 1], tone: ['Colour', OVERLAY_TONES] },
  qr: { text: ['QR content', 1000], size: ['Size', ['s', 'm', 'l']] },
  svg: { source: ['SVG drawing', 8192], size: ['Size', ['s', 'm', 'l']] },
  text: { text: ['Text', 400], size: ['Text size', ['xs', 's', 'm', 'l', 'xl']],
    weight: ['Weight', ['normal', 'strong']], color: ['Colour', ['fg', 'fg-2', ...OVERLAY_TONES]] },
  image: { src: ['Image URL', 500], shape: ['Shape', ['square', 'circle']], size: ['Image size', ['s', 'm', 'l']] },
  badge: { text: ['Badge text', 24], tone: ['Colour', OVERLAY_TONES] },
  dot: { tone: ['Colour', OVERLAY_TONES] },
  progress: { value: ['Value (0–1)', 0, 1, 0.01], label: ['Label', 40], tone: ['Colour', OVERLAY_TONES] },
  countdown: { target: ['Date and time (ISO 8601, include time zone)', 80], label: ['Label', 40] },
  list: { items: ['Items (one per line, up to 10)', 120], style: ['List style', ['bullet', 'number', 'plain']] },
  divider: {},
  compare: { segments: ['Segments'] },
  sparkline: { points: ['Points (3–24 numbers from −1 to 1, separated by commas or spaces)'],
    axis: ['Axis labels (top, middle, bottom; up to 6 characters each, or leave empty)'], tone: ['Colour', OVERLAY_TONES] },
  section: { title: ['Title', 40], icon: ['Icon', OVERLAY_ICON_NAMES], action: ['Note on the right', 24] },
  event: { time: ['Time', 8], text: ['Event text', 120], icon: ['Icon', OVERLAY_ICON_NAMES], tone: ['Colour', OVERLAY_TONES] },
  stat: { label: ['Label', 40], left: ['Left value', 16], right: ['Right value', 16], fraction: ['Left share (0–1)', 0, 1, 0.01], tone: ['Colour', OVERLAY_TONES] },
  status: { label: ['Source', 40], state: ['State', OVERLAY_STATES], detail: ['Detail', 24] },
  meta: { items: ['Facts'] },
  clock: { format: ['Format', ['time', 'seconds', 'date']], label: ['Label', 40] },
};
const OVERLAY_SEGMENT_FIELDS = {
  label: ['Label', 24], value: ['Value', 16], fraction: ['Share (0–1)', 0, 1, 0.01],
  tone: ['Colour', ['', ...OVERLAY_TONES]],
};
const OVERLAY_META_FIELDS = { label: ['Label', 24], value: ['Value', 40], icon: ['Icon', OVERLAY_ICON_NAMES] };
// Repeatable sub-forms: key, singular word, min, max, fields, blank entry.
const OVERLAY_SUBFORMS = {
  compare: ['segments', 'segment', 2, 4, OVERLAY_SEGMENT_FIELDS, () => ({ label: 'Next', value: '', fraction: 0 })],
  meta: ['items', 'fact', 1, 4, OVERLAY_META_FIELDS, () => ({ label: 'Label', value: 'Value' })],
};
const OVERLAY_NAMES = { stack: 'Column', row: 'Row', text: 'Text', image: 'Image',
  badge: 'Badge', dot: 'Status dot', progress: 'Progress bar', countdown: 'Countdown', list: 'List',
  divider: 'Divider', compare: 'Comparison bar', sparkline: 'Small bar chart', section: 'Section header',
  event: 'Timed event', stat: 'Two-sided stat', status: 'Source status', meta: 'Key facts', clock: 'Clock',
  grid: 'Grid', ticker: 'Scrolling ticker', qr: 'QR code', svg: 'Custom SVG' };
const OVERLAY_OPTION_NAMES = { xs: 'Extra small', s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large',
  fg: 'Main text', 'fg-2': 'Quiet text', normal: 'Regular', strong: 'Bold', center: 'Centre',
  bullet: 'Bullets', number: 'Numbered', plain: 'Plain lines', info: 'Information', accent: 'Theme accent',
  time: 'Hours and minutes', seconds: 'Hours, minutes and seconds' };
const OVERLAY_REQUIRED = { text: ['text'], image: ['src'], badge: ['text'], progress: ['value'], countdown: ['target'],
  list: ['items'], compare: ['segments'], sparkline: ['points'], section: ['title'], event: ['time', 'text'],
  stat: ['label', 'left', 'right', 'fraction'], status: ['label', 'state'], meta: ['items'],
  grid: ['columns'], ticker: ['text'], qr: ['text'], svg: ['source'] };
const OVERLAY_MAX_NODES = 80;
const OVERLAY_MAX_BYTES = 49152;
const OVERLAY_PALETTE = [
  ['Text & numbers', ['text', 'badge', 'list', 'meta']],
  ['Layout', ['stack', 'row', 'grid', 'divider', 'section']],
  ['Media', ['image', 'qr', 'svg', 'ticker']],
  ['Charts & stats', ['progress', 'compare', 'sparkline', 'stat']],
  ['Live & status', ['clock', 'countdown', 'event', 'status', 'dot']],
];
const OVERLAY_HELP = {
  text: ['card', 'A heading, a short message or a number.'], badge: ['flag', 'A small label that stands out.'],
  list: ['layers', 'A few lines, with or without bullets.'], meta: ['info', 'Labels paired with short facts.'],
  stack: ['layers', 'Arrange widgets from top to bottom.'], row: ['swap', 'Arrange widgets side by side.'],
  divider: ['swap', 'A quiet line between sections.'], section: ['card', 'A heading with an optional icon and note.'],
  image: ['sun', 'A picture that loads from its web address on the TV.'], progress: ['target', 'Show how far something has progressed.'],
  compare: ['chart', 'Compare two to four shares.'], sparkline: ['pulse', 'A small chart with positive and negative bars.'],
  stat: ['chart', 'Compare two values on one line.'], clock: ['clock', 'The TV’s current time or date.'],
  countdown: ['clock', 'Count down to a date and time.'], event: ['flag', 'A time, an icon and a short event.'],
  status: ['bolt', 'Show whether a source is available.'], dot: ['info', 'A small coloured indicator.'],
  grid: ['layers', 'Arrange widgets in one to three columns.'], ticker: ['swap', 'Scroll a long announcement across the card.'],
  qr: ['target', 'A scannable code for a link or short text.'], svg: ['sun', 'A safe inline vector drawing, without scripts or external resources.'],
};
const OVERLAY_LOOKS = {
  'TV default': {},
  'Ocean': { accent: '#84b5ec', surface: '#191c22', text: '#f0f2f5', muted: '#c4c9d2', line: '#3a3d43' },
  'Warm': { accent: '#efc47d', surface: '#26211d', text: '#faf3e9', muted: '#d2c6b6', line: '#51483b' },
  'Mint': { accent: '#83d9ba', surface: '#142822', text: '#eef9f4', muted: '#b9d6c9', line: '#37584a' },
  'Paper': { accent: '#245d70', surface: '#f4f1e9', text: '#202c30', muted: '#4d6064', line: '#c5cec9', opacity: 1 },
};
const clone = (value) => JSON.parse(JSON.stringify(value));

let overlayCard = { position: 'top-right', size: 'm', seconds: 8,
  root: { type: 'stack', children: [{ type: 'text', text: 'Your card', size: 'l', weight: 'strong' }] } };
let overlayLoaded = JSON.stringify(overlayCard);  // what was last loaded or saved; differing from it means unsaved edits
let overlayError = '';
let overlayJsonDirty = false;
let overlayAsk = null;
let overlaySelected = overlayCard.root;
let overlayValidationBusy = false;
let overlayValidationRevision = 0;
let overlaySchema = null;
let overlayStudioStep = 'start';
const overlayCollapsed = new WeakSet();

const overlayRegions = (card = overlayCard) => {
  const active = card.timeline ? card.timeline[Math.min(studioFrame, card.timeline.length - 1)].card : card;
  return active.regions || [active];
};
const overlayNodeCount = (node) => 1 + (node.children || []).reduce((count, child) => count + overlayNodeCount(child), 0);
const overlayCardCount = (card = overlayCard) => card.timeline
  ? card.timeline.reduce((count, frame) => count + overlayCardCount(frame.card), 0)
  : overlayRegions(card).reduce((count, region) => count + overlayNodeCount(region.root), 0);
// The request body: the draft without the empty Look object the form edits in place.
function overlayBody() {
  const card = clone(overlayCard);
  if (card.theme && !Object.keys(card.theme).length) delete card.theme;
  return card;
}
const overlayDirty = () => JSON.stringify(overlayBody()) !== overlayLoaded;

function overlayTemplates() {
  const soon = new Date(Date.now() + 3600000).toISOString();
  return [
    { name: 'Blank', blurb: 'Start simply with your own words.', card: { seconds: 8, position: 'top-right', size: 'm',
      root: { type: 'stack', gap: 10, children: [{ type: 'text', text: 'Your message', size: 'l', weight: 'strong' }] } } },
    { name: 'Match day', blurb: 'A score across the top, with events and details on the right. Sample values are placeholders.',
      card: { seconds: 0, theme: { accent: '#e8c35a', font: 'condensed' }, regions: [
        { position: 'top', size: 'full', root: { type: 'row', gap: 24, align: 'center', children: [
          { type: 'image', src: 'https://example.com/home-crest.png', shape: 'circle', size: 'm' },
          { type: 'text', text: 'Home team', size: 'l', weight: 'strong' },
          { type: 'text', text: 'Score', size: 'xl', weight: 'strong', color: 'accent' },
          { type: 'text', text: 'Away team', size: 'l', weight: 'strong' },
          { type: 'image', src: 'https://example.com/away-crest.png', shape: 'circle', size: 'm' },
          { type: 'clock', format: 'time', label: 'Local time' },
          { type: 'badge', text: 'Label', tone: 'accent' }] } },
        { position: 'right', size: 'm', root: { type: 'stack', gap: 14, children: [
          { type: 'section', title: 'Timeline', icon: 'clock' },
          { type: 'event', time: 'Time', text: 'Event text', icon: 'ball', tone: 'success' },
          { type: 'event', time: 'Time', text: 'Event text', icon: 'card', tone: 'warning' },
          { type: 'event', time: 'Time', text: 'Event text', icon: 'swap' },
          { type: 'section', title: 'Match stats', icon: 'chart', action: 'Home · Away' },
          { type: 'stat', label: 'Stat one', left: 'Value', right: 'Value', fraction: 0.5 },
          { type: 'stat', label: 'Stat two', left: 'Value', right: 'Value', fraction: 0.5, tone: 'info' },
          { type: 'stat', label: 'Stat three', left: 'Value', right: 'Value', fraction: 0.5, tone: 'info' },
          { type: 'section', title: 'Comparison', icon: 'target' },
          { type: 'compare', segments: [{ label: 'Home', value: 'Share', fraction: 0.4, tone: 'accent' },
            { label: 'Draw', value: 'Share', fraction: 0.2 }, { label: 'Away', value: 'Share', fraction: 0.4, tone: 'info' }] },
          { type: 'section', title: 'Momentum', icon: 'pulse' },
          { type: 'sparkline', points: [0.2, 0.5, 0.3, -0.2, -0.6, -0.3, 0.1, 0.4, 0.7, 0.3], axis: ['Home', '0', 'Away'], tone: 'accent' },
          { type: 'section', title: 'Data sources', icon: 'layers' },
          { type: 'status', label: 'Source A', state: 'unknown', detail: 'Status text' },
          { type: 'status', label: 'Source B', state: 'unknown', detail: 'Status text' }] } }] } },
    { name: 'At a glance', blurb: 'Facts, a countdown and source updates in a side panel. Sample values are placeholders.',
      card: { seconds: 0, position: 'right', size: 'm', root: { type: 'stack', gap: 14, children: [
        { type: 'section', title: 'Today', icon: 'sun', action: 'Update note' },
        { type: 'meta', items: [{ label: 'Fact one', value: 'Value', icon: 'pin' }, { label: 'Fact two', value: 'Value' }, { label: 'Fact three', value: 'Value' }] },
        { type: 'divider' },
        { type: 'section', title: 'Progress', icon: 'target' },
        { type: 'progress', value: 0.6, label: 'Task label', tone: 'accent' },
        { type: 'countdown', target: soon, label: 'Until the next step' },
        { type: 'divider' },
        { type: 'section', title: 'Sources', icon: 'layers' },
        { type: 'status', label: 'Source A', state: 'unknown', detail: 'Status text' },
        { type: 'status', label: 'Source B', state: 'unknown', detail: 'Status text' },
        { type: 'status', label: 'Source C', state: 'unknown' }] } } },
    { name: 'News strip', blurb: 'Short messages along the bottom, without covering the picture.',
      card: { seconds: 20, position: 'bottom', size: 'full', root: { type: 'row', gap: 20, align: 'center', children: [
        { type: 'badge', text: 'Label', tone: 'alert' },
        { type: 'text', text: 'Headline text', size: 'm', weight: 'strong' },
        { type: 'dot', tone: 'accent' },
        { type: 'text', text: 'Second headline text', size: 'm', color: 'fg-2' },
        { type: 'dot', tone: 'accent' },
        { type: 'clock', format: 'time' },
        { type: 'badge', text: 'Label', tone: 'accent' }] } } },
    { name: 'Quick message', blurb: 'A small corner card with a heading and a second line.',
      card: { seconds: 8, position: 'top-right', size: 's', root: { type: 'stack', gap: 6, children: [
        { type: 'row', gap: 12, children: [{ type: 'dot', tone: 'success' }, { type: 'text', text: 'Short message', weight: 'strong' }] },
        { type: 'text', text: 'A quieter second line', size: 's', color: 'fg-2' }] } } },
    { name: 'Countdown', blurb: 'Count down to your next event, in the middle of the screen.',
      card: { seconds: 0, position: 'center', size: 'l', root: { type: 'stack', gap: 10, align: 'center', children: [
        { type: 'text', text: 'Event name', size: 'l', weight: 'strong' },
        { type: 'countdown', target: soon, label: 'Starts in' },
        { type: 'clock', format: 'date' }] } } },
    { name: 'Status board', blurb: 'A tidy overview of facts and whether each source is available. Sample values are placeholders.',
      card: { seconds: 0, position: 'top-left', size: 'l', root: { type: 'stack', gap: 14, children: [
        { type: 'section', title: 'Systems', icon: 'bolt' },
        { type: 'meta', items: [{ label: 'Fact one', value: 'Value' }, { label: 'Fact two', value: 'Value' },
          { label: 'Fact three', value: 'Value' }, { label: 'Fact four', value: 'Value' }] },
        { type: 'divider' },
        { type: 'status', label: 'Source A', state: 'unknown', detail: 'Status text' },
        { type: 'status', label: 'Source B', state: 'unknown', detail: 'Status text' },
        { type: 'status', label: 'Source C', state: 'unknown', detail: 'Status text' },
        { type: 'status', label: 'Source D', state: 'unknown' }] } } },
  ];
}

function newOverlayNode(type) {
  if (['stack', 'row', 'grid'].includes(type)) return { type, ...(type === 'grid' ? { columns: 2 } : {}), children: [{ type: 'text', text: 'Text' }] };
  return { type, ...({
    text: { text: 'Text' }, image: { src: 'https://example.com/image.png' }, badge: { text: 'Ready' },
    ticker: { text: 'Your announcement', speed: 40 }, qr: { text: 'https://example.com' },
    svg: { source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"/></svg>' },
    progress: { value: 0.5 }, countdown: { target: new Date(Date.now() + 300000).toISOString() },
    list: { items: ['First item'] },
    compare: { segments: [{ label: 'First', value: '50%', fraction: 0.5 }, { label: 'Second', value: '50%', fraction: 0.5 }] },
    sparkline: { points: [-0.5, 0, 0.5] },
    section: { title: 'Section title', icon: 'layers' }, event: { time: '00:00', text: 'Event text', icon: 'ball' },
    stat: { label: 'Stat name', left: '50%', right: '50%', fraction: 0.5 }, status: { label: 'Source A', state: 'online' },
    meta: { items: [{ label: 'Label', value: 'Value' }] },
  }[type] || {}) };
}

const cleanText = (value, max) => typeof value === 'string' && [...value].length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const inRange = (value, lo, hi) => typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;

// Validates one widget tree; `counter` is shared across a card's regions so the widget cap applies to the whole card.
function checkOverlayTree(root, counter = { n: 0 }) {
  function check(node, depth) {
    if (++counter.n > OVERLAY_MAX_NODES) throw new Error(`A card may have at most ${OVERLAY_MAX_NODES} widgets across all regions`);
    if (depth > 5) throw new Error('A card may nest at most 5 levels deep');
    if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(OVERLAY_FIELDS, node.type)) {
      throw new Error('Each widget needs a known type.');
    }
    const fields = OVERLAY_FIELDS[node.type];
    const required = OVERLAY_REQUIRED[node.type] || [];
    for (const key of required) if (node[key] === undefined || node[key] === '') throw new Error(`${OVERLAY_NAMES[node.type]} needs ${key}.`);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'children' && ['stack', 'row', 'grid'].includes(node.type)) continue;
      const spec = fields[key];
      if (!Object.hasOwn(fields, key)) throw new Error(`Unknown ${node.type} field: ${key}`);
      if (key === 'items' && node.type === 'list') {
        if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new Error('A list needs 1–10 items.');
        if (value.some((item) => !cleanText(item, 120))) throw new Error('Each list item needs at most 120 characters without control characters.');
      } else if (key === 'items') {
        if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error('Key facts need 1–4 facts.');
        for (const item of value) {
          if (!item || typeof item !== 'object' || Array.isArray(item) || !cleanText(item.label, 24) || !cleanText(item.value, 40) || !item.label || !item.value) {
            throw new Error('Each fact needs a label (up to 24 characters) and a value (up to 40).');
          }
          if (item.icon !== undefined && !Object.hasOwn(OVERLAY_ICONS, item.icon)) throw new Error('Choose a valid fact icon.');
          for (const field of Object.keys(item)) if (!Object.hasOwn(OVERLAY_META_FIELDS, field)) throw new Error(`A fact has no field named ${field}.`);
        }
      } else if (key === 'segments') {
        if (!Array.isArray(value) || value.length < 2 || value.length > 4) throw new Error('A comparison needs 2–4 segments.');
        for (const segment of value) {
          if (!segment || typeof segment !== 'object' || Array.isArray(segment)) throw new Error('Each segment needs a label, value and share.');
          for (const [field, limit] of [['label', 24], ['value', 16]]) {
            if (!cleanText(segment[field], limit)) throw new Error(`Segment ${field} needs at most ${limit} characters without control characters.`);
          }
          if (!inRange(segment.fraction, 0, 1)) throw new Error('Each segment share must be a number from 0 to 1.');
          if (segment.tone !== undefined && !OVERLAY_TONES.includes(segment.tone)) throw new Error('Choose a valid segment colour.');
        }
      } else if (key === 'points') {
        if (!Array.isArray(value) || value.length < 3 || value.length > 24) throw new Error('A small bar chart needs 3–24 points.');
        if (value.some((point) => !inRange(point, -1, 1))) throw new Error('Each chart point must be a number from −1 to 1.');
      } else if (key === 'axis') {
        if (!Array.isArray(value) || value.length !== 3 || value.some((label) => !cleanText(label, 6))) {
          throw new Error('Axis labels are exactly three short texts: top, middle, bottom.');
        }
      } else if (Array.isArray(spec[1])) {
        if (value === '' || !spec[1].includes(value)) throw new Error(`Choose a valid ${key} for ${node.type}.`);
      } else if (spec.length === 4) {
        if (!inRange(value, spec[1], spec[2]) || ['gap', 'columns'].includes(key) && !Number.isInteger(value)) {
          throw new Error(`${key} must be ${spec[1]}–${spec[2]}${['gap', 'columns'].includes(key) ? ', a whole number' : ''}.`);
        }
      } else if (!cleanText(value, spec[1])) {
        throw new Error(`${key} needs at most ${spec[1]} characters without control characters.`);
      }
    }
    if (node.type === 'image' && !/^https?:\/\/[^\s"'<>]+$/u.test(node.src)) throw new Error('Use an http(s) image URL.');
    if (['ticker', 'qr'].includes(node.type) && !node.text) throw new Error('Add text for this widget.');
    if (node.type === 'qr' && new TextEncoder().encode(node.text).length > 2953) throw new Error('QR content must fit in 2953 UTF-8 bytes.');
    if (node.type === 'svg') checkStudioSvg(node.source);
    if (node.type === 'countdown' && (!/^\d{4}-\d{2}-\d{2}T/u.test(node.target) || !Number.isFinite(Date.parse(node.target)))) {
      throw new Error('Use an ISO datetime such as 2026-12-25T18:00:00Z.');
    }
    if (['stack', 'row', 'grid'].includes(node.type)) {
      const limit = node.type === 'row' ? 10 : 20;
      if (!Array.isArray(node.children) || node.children.length < 1 || node.children.length > limit) {
        throw new Error(`${node.type} needs 1–${limit} children. Add a widget.`);
      }
      node.children.forEach((child) => check(child, depth + 1));
    }
  }
  check(root, 1);
  if (new TextEncoder().encode(JSON.stringify({ root })).length > OVERLAY_MAX_BYTES) throw new Error(`Use at most ${OVERLAY_MAX_BYTES} bytes of JSON.`);
  return root;
}

function checkOverlayTheme(theme) {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) throw new Error('Look settings must be a JSON object.');
  for (const [key, value] of Object.entries(theme)) {
    if (Object.hasOwn(OVERLAY_THEME_COLORS, key)) {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) throw new Error(`Look ${key} must be a #rrggbb colour.`);
    } else if (Object.hasOwn(OVERLAY_THEME_RANGES, key)) {
      const [, lo, hi] = OVERLAY_THEME_RANGES[key];
      if (!inRange(value, lo, hi) || key === 'radius' && !Number.isInteger(value)) throw new Error(`Look ${key} must be ${lo}–${hi}${key === 'radius' ? ', a whole number' : ''}.`);
    } else if (key === 'font') {
      if (!Object.hasOwn(OVERLAY_FONTS, value)) throw new Error('Choose a valid font.');
    } else throw new Error(`Look has no setting named ${key}.`);
  }
  return theme;
}

// Validates a whole request body as POST /api/overlay and PUT /api/designs/{name} accept it.
function checkOverlayCard(card) {
  checkStudioCard(card);
  return card;
}

// Assistants often surround JSON with prose or fences; scan braces without counting braces inside strings.
function extractOverlayObject(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Paste the card’s JSON first.');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON object found. Ask your assistant for one JSON object, then paste it here.');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      let value;
      try { value = JSON.parse(text.slice(start, i + 1)); }
      catch (err) { throw new Error('The JSON could not be read: ' + err.message); }
      return value.type && !value.root && !value.regions ? { root: value } : value;
    }
  }
  throw new Error('The JSON is incomplete. Copy the whole object, including its closing brace.');
}

function parseOverlayPaste(text) {
  return checkOverlayCard(extractOverlayObject(text));
}

function overlayAiPrompt() {
  const describe = (fields) => Object.entries(fields).map(([key, spec]) => {
    const rule = Array.isArray(spec[1]) ? spec[1].filter(value => value !== '').join('|')
      : spec.length === 4 ? `number ${spec[1]}–${spec[2]}${key === 'gap' ? ', integer' : ''}`
        : typeof spec[1] === 'number' ? `string, max ${spec[1]} characters` : spec[0];
    return `${key}: ${rule}`;
  }).join('; ');
  const explanation = [
    'Help me design a card for my LG TV. I will describe what I want after these rules.',
    'A card is text, numbers and simple widgets drawn over the TV picture, not a web page.',
    'Return a complete card object, ready to paste into the Card studio.',
    'Use a root widget for one card, or regions for up to four separate screen areas.',
    'Use groups to arrange widgets: stack vertically, row side by side.',
    'Keep it readable from across a room; short labels work best.',
    'The theme controls the whole card, not individual widget CSS.',
    'Clock and countdown widgets update automatically on the TV.',
    'Use placeholder text where you do not know a value; never invent statistics.',
    'Answer with one JSON object only. No markdown, comments, explanation, HTML or CSS.',
  ];
  const rules = [
    'Envelope: {"position"?:position,"size"?:size,"seconds"?:integer,"theme"?:theme,"root":widget} OR {"seconds"?:integer,"theme"?:theme,"regions":[{"position":position,"size"?:size,"root":widget}]}. Do not combine root and regions.',
    `Positions: ${Object.keys(OVERLAY_POSITIONS).join(', ')}. Top/bottom are full-width bars; left/right are full-height panels between any bars. Other positions float. Regions: 1–4, unique positions.`,
    `Sizes: ${Object.keys(OVERLAY_SIZES).join(', ')}. Seconds: integer 0–300; 0 stays until hidden; default 8.`,
    'Optional card or region animation: {enter:"none|fade|slide|wipe",exit:"none|fade|slide|wipe",duration_ms:integer 0–2000}. Optional offset:{x:integer -1920..1920,y:integer -1080..1080}; edges remain docked.',
    'Optional top-level behavior:{on_foreground:"keep|hide|shrink",ambient_dim:boolean}. To sequence cards use timeline:[{seconds:integer 1–300,card:normalCard}], 1–4 steps, instead of root/regions. No nested timeline; caps apply across all steps.',
    'Optional design bindings:[{target:JSON pointer to existing text/numeric widget field,source:{kind:"json|homeassistant",url:"https://...",path:"dot.path or /pointer",token?:secret,allow_private?:boolean},fallback?:explicit scalar}], at most 20. Never bind widget types, URLs, SVG or layout. Private addresses require explicit allow_private. Never invent credentials or fallback values.',
    `Theme (all optional): ${Object.keys(OVERLAY_THEME_COLORS).map(key => key + ': #rrggbb').join('; ')}; `
      + Object.entries(OVERLAY_THEME_RANGES).map(([key, spec]) => `${key}: ${spec[1]}–${spec[2]}${key === 'radius' ? ' integer' : ''}`).join('; ')
      + `; font: ${Object.keys(OVERLAY_FONTS).join('|')}.`,
    `Tones: ${OVERLAY_TONES.join(', ')}. Icons: ${Object.keys(OVERLAY_ICONS).join(', ')}. Omit icon to use none.`,
    `Caps: ${OVERLAY_MAX_NODES} widgets across all regions; maximum depth 5 (root is level 1); ${OVERLAY_MAX_BYTES} UTF-8 bytes for the whole object. No unknown fields. Text has no control characters.`,
    ...Object.entries(OVERLAY_FIELDS).map(([type, fields]) => {
      const required = OVERLAY_REQUIRED[type] || [];
      let extra = '';
      if (['stack', 'row', 'grid'].includes(type)) extra = `; children: ${type === 'row' ? '1–10' : '1–20'} widgets, required`;
      if (type === 'list') extra = '; items: array of 1–10 strings, each max 120 characters';
      if (OVERLAY_SUBFORMS[type]) {
        const [key, , min, max, childFields] = OVERLAY_SUBFORMS[type];
        extra = `; ${key}: array of ${min}–${max} objects {${describe(childFields)}}; `
          + (type === 'compare' ? 'each needs label, value, fraction; tone optional' : 'each needs nonempty label and value; icon optional');
      }
      if (type === 'image') extra = '; src must be an http(s) URL, not a local path or data URL';
      if (type === 'countdown') extra = '; target must be a valid ISO datetime including time zone, e.g. 2026-12-25T18:00:00Z';
      if (type === 'sparkline') extra = '; points: 3–24 numbers from -1 to 1; axis optional: exactly three strings, max 6 characters each';
      if (type === 'svg') extra = '; max 8192 ASCII characters; geometry-only svg/g/path/rect/circle/ellipse/line/polyline/polygon; no text, controls, scripts, styles, event handlers, entities or external references';
      if (type === 'qr') extra = '; text must also fit within 2953 UTF-8 bytes (version 40-L capacity)';
      return `Widget ${type}: {type:"${type}"; ${describe(fields)}}. Required: ${required.join(', ') || 'type only'}${extra}. All other fields optional.`;
    }),
    'Example — a short message:',
    JSON.stringify({ position: 'top-right', size: 's', seconds: 8, root: { type: 'text', text: 'Your message', weight: 'strong' } }),
    'Example — two screen areas:',
    JSON.stringify({ seconds: 0, regions: [
      { position: 'top', size: 'full', root: { type: 'row', gap: 20, children: [{ type: 'text', text: 'Event name', weight: 'strong' }, { type: 'clock' }] } },
      { position: 'right', size: 'm', root: { type: 'stack', children: [{ type: 'section', title: 'Updates', icon: 'info' }, { type: 'text', text: 'Event text' }] } },
    ] }),
    'My card request: [describe what the card should show, where it should appear, and the colours you prefer].',
    'Answer with one JSON object only.',
  ];
  return explanation.concat('', 'CARD RULES', ...rules).join('\n');
}

async function applyOverlayJson(source, messageElement = $('ov-json-msg')) {
  if (overlayValidationBusy) return false;
  const text = typeof source === 'string' ? source : source.value;
  let card, clientError = '';
  try { card = extractOverlayObject(text); }
  catch (err) {
    if (source === $('ov-json') || text === $('ov-json').value) $('ov-json').setAttribute('aria-invalid', 'true');
    result(messageElement, err.message, 'error');
    return false;
  }
  try { checkOverlayCard(card); } catch (err) { clientError = err.message; }
  result($('ov-builder-msg'), clientError || 'The card passes the checks in this browser.', clientError ? 'error' : 'ok');
  overlayValidationBusy = true;
  const revision = ++overlayValidationRevision;
  const previousDraft = JSON.stringify(overlayBody());
  $('ov-paste-apply').disabled = $('ov-json-apply').disabled = true;
  result(messageElement, 'Checking the card with your server…');
  syncNotify();
  try {
    const reply = await call('POST', '/api/overlay/validate', { json: card });
    if (revision !== overlayValidationRevision) return false;
    if (previousDraft !== JSON.stringify(overlayBody()) || typeof source !== 'string' && source.value !== text) {
      result(messageElement, 'The draft changed while it was being checked. Apply your JSON again to use it.');
      return false;
    }
    if (clientError) {
      result(messageElement, 'The server accepted this card, but the browser cannot preview it: ' + clientError, 'error');
      return false;
    }
    checkOverlayCard(reply.card);
    overlayCard = clone(reply.card);
    overlaySelected = overlayRegions()[0].root;
    updateOverlayDraft(true);
    const verdict = `Looks good — ${reply.widgets} ${reply.widgets === 1 ? 'widget' : 'widgets'}, `
      + (reply.bytes < 1024 ? `${reply.bytes} bytes.` : `${(reply.bytes / 1024).toFixed(1)} KB.`);
    result(messageElement, verdict, 'ok');
    result($('ov-builder-msg'), verdict, 'ok');
    showStudioStep('design');
    return true;
  } catch (err) {
    if (revision === overlayValidationRevision) result(messageElement, err.message, 'error');
    return false;
  } finally {
    if (revision === overlayValidationRevision) {
      overlayValidationBusy = false;
      $('ov-paste-apply').disabled = $('ov-json-apply').disabled = false;
      syncNotify();
      studioQueueLive();
    }
  }
}

function showStudioStep(step) {
  for (const button of document.querySelectorAll('[data-studio-step]')) {
    if (button.dataset.studioStep === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('[data-studio-panel]')) panel.hidden = panel.dataset.studioPanel !== step;
  overlayStudioStep = step;
  placeWidgetPreview(step);
}

async function fetchOverlaySchema() {
  if (!overlaySchema) overlaySchema = await call('GET', '/api/overlay/schema');
  return overlaySchema;
}

function overlayIcon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'w-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', OVERLAY_ICONS[name]);
  svg.append(path);
  return svg;
}

function overlayFieldError(node, key, spec, required = false) {
  if (required && (node[key] === undefined || node[key] === '')) return `Add ${spec[0].toLowerCase()} here.`;
  if (node.type) {
    const candidate = newOverlayNode(node.type);
    if (node[key] === undefined) delete candidate[key]; else candidate[key] = node[key];
    try { checkOverlayTree(candidate); } catch (err) { return err.message; }
  } else if (node[key] !== undefined) {
    const value = node[key];
    if (Array.isArray(spec[1]) && value && !spec[1].includes(value)) return 'Choose one of the listed options.';
    if (spec.length === 4 && !inRange(value, spec[1], spec[2])) return `Use a number from ${spec[1]} to ${spec[2]}.`;
    if (spec.length === 2 && typeof spec[1] === 'number' && !cleanText(value, spec[1])) return `Use at most ${spec[1]} characters.`;
  }
  return '';
}

function overlayControls(node, fields, requiredFields) {
  const controls = h('div', { class: 'pair' });
  const required = requiredFields || OVERLAY_REQUIRED[node.type] || [];
  for (const [key, spec] of Object.entries(fields)) {
    if (key === 'segments' || key === 'items' && node.type === 'meta') continue;
    const [label, setting, max, step] = spec;
    const error = h('span', { class: 'field-error', role: 'status', hidden: true });
    let input, wrap, redraw;
    if (key === 'axis') {
      const parts = ['top', 'middle', 'bottom'].map((end, i) => h('input', { type: 'text', maxlength: 6,
        'aria-label': `Axis label, ${end}`, value: (node.axis || [])[i] ?? '' }));
      for (const part of parts) part.addEventListener('input', () => {
        node.axis = parts.map((p) => p.value);
        if (node.axis.every((text) => text === '')) delete node.axis;
        updateOverlayDraft(false);
      });
      controls.append(h('div', { class: 'field' }, h('span', { class: 'field-label', text: label }), h('span', { class: 'row nowrap' }, parts)));
      continue;
    }
    if (Array.isArray(setting)) {
      const fallback = { size: 'm', color: 'fg', align: 'start', weight: 'normal', style: 'bullet',
        tone: node.type === 'stat' ? 'accent' : 'info', shape: 'square', state: 'online', format: 'time' }[key];
      input = h('select', {}, setting.map((value) => h('option', { value, text: OVERLAY_OPTION_NAMES[value] || (value ? value[0].toUpperCase() + value.slice(1) : key === 'icon' ? 'None' : 'Default'),
        selected: value === (node[key] ?? (setting.includes('') ? '' : fallback)) })));
      if (key === 'icon') {
        const glyph = h('span', { class: 'overlay-glyph' });
        redraw = () => glyph.replaceChildren(...(input.value ? [overlayIcon(input.value)] : []));
        redraw();
        wrap = h('span', { class: 'overlay-icon-pick' }, input, glyph);
      }
    } else if (key === 'points' || key === 'items' || key === 'source') {
      input = h('textarea', { rows: 3 });
      input.value = key === 'source' ? node[key] || '' : (node[key] || []).join(key === 'points' ? ', ' : '\n');
    } else {
      input = h('input', step !== undefined
        ? { type: key === 'value' || key === 'fraction' ? 'range' : 'number', min: setting, max, step, value: node[key] ?? (key === 'gap' ? 10 : 0) }
        : { type: key === 'src' ? 'url' : 'text', maxlength: setting, value: node[key] ?? '' });
    }
    const out = step !== undefined ? h('output', { class: 'num', text: input.value }) : null;
    const validate = () => {
      const message = overlayFieldError(node, key, spec, required.includes(key));
      error.textContent = message;
      error.hidden = !message;
      if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    };
    input.addEventListener('input', () => {
      node[key] = key === 'items' ? input.value.split('\n') : key === 'points'
        ? input.value.trim().split(/[,\s]+/u).filter(Boolean).map(Number) : step !== undefined ? Number(input.value) : input.value;
      if (input.value === '' && (step !== undefined || Array.isArray(setting) || !required.includes(key))) delete node[key];
      if (redraw) redraw();
      if (out) out.textContent = input.value;
      validate();
      updateOverlayDraft(false);
    });
    const hint = key === 'src' ? 'Use a public http(s) image address. The picture loads on your TV; this preview uses a placeholder.'
      : key === 'target' ? 'Include the time zone, for example 2026-12-25T18:00:00Z.'
        : key === 'fraction' || key === 'value' && step ? '0 means none; 1 means the whole amount.'
          : typeof setting === 'number' && step === undefined ? `Up to ${setting} characters${required.includes(key) ? ' · required' : ' · optional'}.` : '';
    const wide = ['src', 'target', 'points', 'items', 'source'].includes(key) || step === undefined && typeof setting === 'number' && setting > 80;
    controls.append(h('label', { class: 'field' + (wide ? ' widget-field-wide' : '') }, h('span', { class: 'field-head' }, label, out),
      wrap || input, hint && h('span', { class: 'hint', text: hint }), error));
    validate();
  }
  return controls;
}

function findOverlayNode(target) {
  const visit = (node, parent, index, depth) => node === target ? { node, parent, index, depth }
    : (node.children || []).map((child, i) => visit(child, node, i, depth + 1)).find(Boolean);
  for (const region of overlayRegions()) {
    const found = visit(region.root, null, 0, 1);
    if (found) return { ...found, region };
  }
  return null;
}

function selectOverlayWidget(node) {
  overlaySelected = node;
  for (let found = findOverlayNode(node); found?.parent; found = findOverlayNode(found.parent)) overlayCollapsed.delete(found.parent);
  renderOverlayBuilder();
  $('ov-builder').querySelector('.widget-select[aria-pressed="true"]')?.focus();
  if (typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches) $('ov-builder').querySelector('.widget-inspector')?.scrollIntoView({ block: 'start' });
}

function overlayNodeSummary(node) {
  if (node.children) return `${node.children.length} ${node.children.length === 1 ? 'item' : 'items'}`;
  return node.text || node.title || node.label || node.state || node.src || '';
}

function overlayWidgetTools(node) {
  const found = findOverlayNode(node);
  if (!found?.parent) return h('p', { class: 'hint', text: node.children ? 'This is the area’s main layout. Add widgets inside it to build your card.' : 'This is the area’s only widget. Add another to arrange them together.' });
  const { parent, index } = found, siblings = parent.children;
  const tool = (text, disabled, act) => h('button', { class: 'btn quiet', type: 'button', text, disabled,
    'aria-label': `${text} (${OVERLAY_NAMES[node.type]} ${index + 1})`, onclick: () => {
      studioCaptureBindingAnchors(); act(); studioRebaseBindings(); updateOverlayDraft(true);
    } });
  return h('div', { class: 'row overlay-tools widget-actions', 'aria-label': 'Selected widget actions' },
    tool('Move up', index === 0, () => siblings.splice(index - 1, 2, node, siblings[index - 1])),
    tool('Move down', index === siblings.length - 1, () => siblings.splice(index, 2, siblings[index + 1], node)),
    tool('Duplicate', siblings.length >= (parent.type === 'row' ? 10 : 20) || overlayCardCount() + overlayNodeCount(node) > OVERLAY_MAX_NODES,
      () => siblings.splice(index + 1, 0, clone(node))),
    tool('Remove widget', siblings.length <= 1, () => { siblings.splice(index, 1); overlaySelected = parent; }));
}

function overlayBuilder(node, depth = 1, parent = null, index = 0) {
  const box = h('li', { class: 'widget-tree-row' });
  const line = h('div', { class: 'widget-node' });
  wireStudioWidgetDrag(line, node);
  let branch;
  if (node.children) {
    const toggle = h('button', { class: 'widget-toggle', type: 'button',
      'aria-label': `Expand or collapse ${OVERLAY_NAMES[node.type]}`, 'aria-expanded': String(!overlayCollapsed.has(node)),
      onclick: () => {
        if (overlayCollapsed.has(node)) overlayCollapsed.delete(node); else overlayCollapsed.add(node);
        branch.hidden = overlayCollapsed.has(node);
        toggle.setAttribute('aria-expanded', String(!branch.hidden));
      } });
    line.append(toggle);
  } else line.append(h('span', { class: 'widget-toggle-space', 'aria-hidden': 'true' }));
  line.append(h('button', { class: 'widget-select', type: 'button', 'aria-pressed': String(node === overlaySelected),
    onclick: () => selectOverlayWidget(node) },
    overlayIcon(OVERLAY_HELP[node.type][0]), h('span', { text: OVERLAY_NAMES[node.type] }),
    h('small', { text: overlayNodeSummary(node), title: overlayNodeSummary(node) })));
  box.append(line);
  if (node.children) {
    branch = h('ol', { class: 'widget-branch', hidden: overlayCollapsed.has(node) },
      node.children.map((child, i) => overlayBuilder(child, depth + 1, node, i)));
    box.append(branch);
  }
  return box;
}

function renderOverlayInspector(node) {
  const found = findOverlayNode(node), trail = [];
  for (let entry = found; entry; entry = entry.parent ? findOverlayNode(entry.parent) : null) trail.unshift(entry.node);
  const breadcrumbs = h('nav', { class: 'widget-breadcrumbs', 'aria-label': 'Selected widget location' },
    trail.map((item, i) => item === node ? h('span', { text: OVERLAY_NAMES[item.type], 'aria-current': 'location' })
      : h('button', { type: 'button', text: i === 0 ? 'Card layout' : OVERLAY_NAMES[item.type], onclick: () => selectOverlayWidget(item) })));
  const box = h('section', { class: 'widget-inspector', 'aria-label': 'Selected widget settings' },
    breadcrumbs, h('header', { class: 'widget-inspector-head' }, h('h3', { text: OVERLAY_NAMES[node.type] }),
      h('p', { class: 'hint', text: OVERLAY_HELP[node.type][1] })), overlayWidgetTools(node));
  const picker = h('select', { 'aria-label': 'Widget type' }, Object.keys(OVERLAY_FIELDS).map((type) => h('option', {
    value: type, text: OVERLAY_NAMES[type], selected: node.type === type,
    disabled: ['stack', 'row', 'grid'].includes(type) && ((found?.depth || 1) >= 5 || !node.children && overlayCardCount() >= OVERLAY_MAX_NODES),
  })));
  const typeError = h('p', { class: 'field-error', role: 'status', hidden: true });
  picker.addEventListener('change', () => {
    const keepChildren = node.children && ['stack', 'row', 'grid'].includes(picker.value);
    if (keepChildren && picker.value === 'row' && node.children.length > 10) {
      picker.value = node.type;
      typeError.textContent = 'A row fits up to 10 items. Keep this column or choose a grid.';
      typeError.hidden = false;
      return;
    }
    typeError.hidden = true;
    const replace = () => {
      const replacement = newOverlayNode(picker.value);
      if (keepChildren) {
        replacement.children = node.children;
        if ('gap' in node) replacement.gap = node.gap;
        if (picker.value !== 'grid' && 'align' in node) replacement.align = node.align;
      }
      for (const key of Object.keys(node)) delete node[key];
      Object.assign(node, replacement);
      updateOverlayDraft(true);
    };
    if (node.children && !keepChildren) askInPlace(box, 'Changing this layout to a single widget removes its contents. Continue?', 'Change type', replace);
    else replace();
  });
  box.append(h('label', { class: 'field' }, 'Widget type', picker), typeError, overlayControls(node, OVERLAY_FIELDS[node.type]));
  if (OVERLAY_SUBFORMS[node.type]) {
    const [key, word, min, max, fields, blank] = OVERLAY_SUBFORMS[node.type];
    const Word = word[0].toUpperCase() + word.slice(1);
    node[key].forEach((entry, i) => {
      const row = h('fieldset', { class: 'overlay-segment' }, h('legend', { text: `${Word} ${i + 1}` }),
        overlayControls(entry, fields, node.type === 'meta' ? ['label', 'value'] : []));
      row.append(h('button', { class: 'btn quiet', type: 'button', text: `Remove ${word}`, 'aria-label': `Remove ${word} ${i + 1}`,
        disabled: node[key].length <= min, onclick: () => { node[key].splice(i, 1); updateOverlayDraft(true); } }));
      box.append(row);
    });
    box.append(h('button', { class: 'btn', type: 'button', text: `Add ${word}`, disabled: node[key].length >= max,
      onclick: () => { node[key].push(blank()); updateOverlayDraft(true); } }));
  }
  box.append(studioPresetControls(node));
  return box;
}

function overlayAddTarget() {
  const selected = findOverlayNode(overlaySelected) || findOverlayNode(overlayRegions()[0].root);
  return selected.node.children ? { ...selected, group: selected.node, childDepth: selected.depth + 1 }
    : selected.parent ? { ...selected, group: selected.parent, childDepth: selected.depth }
      : { ...selected, group: null, childDepth: 2 };
}

function canAddOverlayWidget(type) {
  const target = overlayAddTarget();
  const added = overlayNodeCount(newOverlayNode(type)) + (target.group ? 0 : 1);
  return overlayCardCount() + added <= OVERLAY_MAX_NODES && target.childDepth + (['stack', 'row', 'grid'].includes(type) ? 1 : 0) <= 5
    && (!target.group || target.group.children.length < (target.group.type === 'row' ? 10 : 20));
}

function addOverlayWidget(type) {
  if (!Object.hasOwn(OVERLAY_FIELDS, type) || !canAddOverlayWidget(type)) return;
  const target = overlayAddTarget(), node = newOverlayNode(type);
  if (target.group) target.group.children.splice(target.node.children ? target.group.children.length : target.index + 1, 0, node);
  else target.region.root = { type: 'stack', gap: 10, children: [target.node, node] };
  overlaySelected = node;
  updateOverlayDraft(true);
  $('ov-builder').querySelector('.widget-inspector select')?.focus();
}

function regionControls(region, i, regions) {
  const multi = 'regions' in studioWorkingCard();
  const box = h('fieldset', { class: 'overlay-region' }, h('legend', { text: multi ? `Area ${i + 1}` : 'Where on the TV?' }));
  const occupied = (value) => multi && regions.some((other) => other !== region && other.position === value);
  const position = h('select', { 'aria-label': `Position for area ${i + 1}` }, Object.entries(OVERLAY_POSITIONS).map(([value, text]) => h('option', {
    value, text, selected: value === (region.position || 'top-right'), disabled: occupied(value) })));
  position.addEventListener('change', () => { region.position = position.value; updateOverlayDraft(true); });
  const picker = h('div', { class: 'position-picker', role: 'group', 'aria-label': `Choose where area ${i + 1} appears on the TV` },
    Object.entries(OVERLAY_POSITIONS).map(([value, text]) => h('button', { type: 'button', text, dataset: { position: value },
      'aria-pressed': String(value === (region.position || 'top-right')), disabled: occupied(value),
      onclick: () => {
        region.position = value; updateOverlayDraft(true);
        $('ov-builder').querySelector('.position-picker')?.querySelector(`[data-position="${value}"]`)?.focus();
      } })));
  const size = h('select', {}, Object.entries(OVERLAY_SIZES).map(([value, text]) => h('option', { value, text, selected: value === (region.size || 'm') })));
  size.addEventListener('change', () => { region.size = size.value; updateOverlayDraft(false); });
  box.append(picker, h('div', { class: 'pair overlay-region-head' }, h('label', { class: 'field' }, 'Position', position),
    h('label', { class: 'field' }, 'Size', size),
    multi && h('button', { class: 'btn quiet', type: 'button', text: 'Remove region', 'aria-label': `Remove region ${i + 1}`,
      disabled: regions.length <= 1, onclick: () => {
        askInPlace(box, `Remove area ${i + 1} and its widgets?`, 'Remove', () => { regions.splice(i, 1); updateOverlayDraft(true); });
      } })));
  box.append(studioRegionExtras(region));
  return box;
}

function placeWidgetPreview(step, dock = $('ov-preview-dock')) {
  const grid = $('ov-widget-editor').parentElement;
  if (!grid || !dock) return;
  grid.dataset.step = step;
  const slot = $('ov-builder').querySelector('.widget-preview-slot');
  if (step === 'design' && slot) {
    if (!dock.dataset.widgetDocked && typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches) dock.open = false;
    dock.dataset.widgetDocked = 'true';
    slot.append(dock);
  } else grid.append(dock);
}

function renderOverlayBuilder() {
  const regions = overlayRegions();
  if (!findOverlayNode(overlaySelected)) overlaySelected = regions[0].root;
  const active = findOverlayNode(overlaySelected).region, area = regions.indexOf(active);
  const dock = $('ov-preview-dock');
  const tabs = h('div', { class: 'widget-areas', role: 'group', 'aria-label': 'Screen areas' },
    regions.map((region, i) => h('button', { type: 'button', class: 'btn quiet', 'aria-pressed': String(region === active),
      text: `${i + 1}. ${OVERLAY_POSITIONS[region.position || 'top-right']}`, onclick: () => selectOverlayWidget(region.root) })));
  if ('regions' in studioWorkingCard()) tabs.append(h('button', { class: 'btn quiet', type: 'button', text: 'Add region',
    disabled: regions.length >= 4 || overlayCardCount() + 2 > OVERLAY_MAX_NODES, onclick: () => {
      const position = Object.keys(OVERLAY_POSITIONS).find(p => !regions.some(r => r.position === p));
      const region = { position, size: 'm', root: newOverlayNode('stack') };
      regions.push(region); overlaySelected = region.root; updateOverlayDraft(true);
    } }));
  const outline = h('aside', { class: 'widget-outline', 'aria-label': 'Card contents' },
    h('header', { class: 'widget-outline-head' }, h('h3', { text: 'Contents' }),
      h('span', { class: 'hint', text: `${overlayNodeCount(active.root)} widgets` })),
    h('p', { class: 'hint', text: 'Drag to reorder. Select a row to edit; arrows open or close a layout.' }),
    h('ol', { class: 'widget-tree' }, overlayBuilder(active.root)),
    h('details', { class: 'widget-placement' }, h('summary', { text: 'Position, size & motion' }), regionControls(active, area, regions)),
    studioPresetPalette());
  const target = overlayAddTarget();
  const search = h('input', { type: 'search', placeholder: 'Find a widget…', 'aria-label': 'Find a widget to add' });
  const empty = h('p', { class: 'hint', text: 'No matching widgets. Try text, image, chart or layout.', hidden: true });
  const groups = OVERLAY_PALETTE.map(([title, types]) => {
    const items = types.map(type => ({ type, element: h('button', { class: 'palette-item', type: 'button', disabled: !canAddOverlayWidget(type),
      onclick: () => addOverlayWidget(type) }, overlayIcon(OVERLAY_HELP[type][0]),
      h('span', {}, h('strong', { text: OVERLAY_NAMES[type] }), h('small', { text: OVERLAY_HELP[type][1] }))) }));
    return { items, element: h('section', { class: 'palette-group' }, h('h4', { text: title }), items.map(item => item.element)) };
  });
  const palette = h('details', { class: 'widget-palette widget-add-picker' }, h('summary', { text: 'Add widget' }),
    h('div', { class: 'widget-library' }, search,
      h('p', { class: 'hint', text: target.node.children ? `Add inside this ${OVERLAY_NAMES[target.node.type].toLowerCase()}.`
        : `Add after the selected ${OVERLAY_NAMES[target.node.type].toLowerCase()}.` }),
      groups.map(group => group.element), empty));
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    for (const group of groups) {
      for (const item of group.items) item.element.hidden = !`${OVERLAY_NAMES[item.type]} ${OVERLAY_HELP[item.type][1]}`.toLowerCase().includes(query);
      group.element.hidden = group.items.every(item => item.element.hidden);
    }
    empty.hidden = groups.some(group => !group.element.hidden);
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { palette.open = false; palette.querySelector('summary').focus(); }
  });
  $('ov-builder').replaceChildren(h('div', { class: 'widget-toolbar' }, tabs, palette),
    h('div', { class: 'widget-workspace' }, outline, renderOverlayInspector(overlaySelected),
      h('aside', { class: 'widget-preview-slot', 'aria-label': 'Live TV preview' })));
  placeWidgetPreview(overlayStudioStep, dock);
}

// Colour, opacity, radius, zoom and font controls writing into `theme` in place; `keys` picks a compact subset.
function themeForm(theme, onChange, keys = [...Object.keys(OVERLAY_THEME_COLORS), ...Object.keys(OVERLAY_THEME_RANGES), 'font']) {
  const form = h('div', { class: 'pair theme-form' });
  for (const key of keys) {
    if (OVERLAY_THEME_COLORS[key]) {
      const [label, fallback] = OVERLAY_THEME_COLORS[key];
      const input = h('input', { type: 'color', value: theme[key] || fallback, 'aria-label': label + ' colour' });
      const clear = h('button', { class: 'btn quiet', type: 'button', text: 'Clear', disabled: !theme[key], 'aria-label': `Clear the ${label.toLowerCase()} colour (use the TV default)` });
      input.addEventListener('input', () => { theme[key] = input.value; clear.disabled = false; onChange(); });
      clear.addEventListener('click', () => { delete theme[key]; input.value = fallback; clear.disabled = true; onChange(); });
      form.append(h('div', { class: 'field' }, h('span', { class: 'field-label', text: label }), h('span', { class: 'row nowrap' }, input, clear)));
    } else if (OVERLAY_THEME_RANGES[key]) {
      const [label, min, max, step, fallback] = OVERLAY_THEME_RANGES[key];
      const out = h('output', { class: 'num', text: String(theme[key] ?? fallback) });
      const input = h('input', { type: 'range', min, max, step, value: theme[key] ?? fallback, 'aria-label': label });
      input.addEventListener('input', () => {
        out.textContent = input.value;
        if (Number(input.value) === fallback) delete theme[key]; else theme[key] = Number(input.value);
        onChange();
      });
      form.append(h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('span', { class: 'field-label', text: label }), out), input));
    } else {
      const input = h('select', { 'aria-label': 'Font' }, Object.entries(OVERLAY_FONTS).map(([value, text]) => h('option', { value, text, selected: (theme.font || 'sans') === value })));
      input.addEventListener('change', () => { if (input.value === 'sans') delete theme.font; else theme.font = input.value; onChange(); });
      form.append(h('label', { class: 'field' }, 'Font', input));
    }
  }
  return form;
}

function previewOverlayNode(node) {
  const el = h(node.type === 'text' ? 'p' : node.type === 'divider' ? 'hr' : node.type === 'list' ? 'ul' : node.type === 'badge' || node.type === 'dot' ? 'span' : 'div', { class: 'w-' + node.type });
  for (const key of ['size', 'weight', 'color', 'tone', 'align', 'style', 'shape', 'state']) if (node[key]) el.dataset[key] = node[key];
  if (node.type === 'grid') el.style.gridTemplateColumns = `repeat(${node.columns}, minmax(0, 1fr))`;
  if (node.children) {
    if (node.gap !== undefined) el.style.gap = node.gap + 'px';
    el.append(...node.children.map(previewOverlayNode));
  } else if (node.type === 'text') {
    el.textContent = node.text;
    el.dataset.size = node.size || 'm';
  } else if (node.type === 'ticker') {
    el.dataset.tone = node.tone || 'info';
    el.dataset.speed = node.speed || 50;
    el.append(h('span', { class: 'w-ticker-text', text: node.text }));
  } else if (node.type === 'qr') {
    studioPreviewQr(el, node.text);
  } else if (node.type === 'svg') {
    studioPreviewSvg(el, node.source);
  } else if (node.type === 'image') {
    // The page's same-origin CSP deliberately forbids fetching arbitrary TV image URLs.
    el.dataset.shape = node.shape || 'square';
    el.dataset.size = node.size || 'm';
    el.append(h('span', { text: node.shape === 'circle' ? 'Image' : 'Image · loads on TV' }));
    el.setAttribute('aria-label', 'Image from ' + node.src + ' · loads on TV');
  } else if (node.type === 'badge') {
    el.textContent = node.text;
    el.dataset.tone = node.tone || 'info';
  } else if (node.type === 'dot') {
    el.dataset.tone = node.tone || 'info';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', (node.tone || 'info') + ' indicator');
  } else if (node.type === 'progress') {
    el.dataset.tone = node.tone || 'info';
    const fill = h('div', { class: 'w-progress-fill' });
    fill.style.width = (node.value * 100) + '%';
    el.append(h('div', { class: 'w-progress-track', role: 'progressbar', 'aria-valuenow': node.value, 'aria-valuemin': 0, 'aria-valuemax': 1, 'aria-label': node.label || 'Progress' }, fill));
    if (node.label) el.append(h('span', { class: 'w-progress-label', text: node.label }));
  } else if (node.type === 'countdown') {
    el.append(h('span', { class: 'w-countdown-clock', dataset: { target: node.target } }));
    if (node.label) el.append(h('span', { class: 'w-countdown-label', text: node.label }));
  } else if (node.type === 'clock') {
    el.append(h('span', { class: 'w-clock-face', dataset: { format: node.format || 'time' } }));
    if (node.label) el.append(h('span', { class: 'w-clock-label', text: node.label }));
  } else if (node.type === 'compare') {
    const labels = h('div', { class: 'w-compare-labels' });
    const bar = h('div', { class: 'w-compare-bar' });
    for (const segment of node.segments) {
      labels.append(h('div', { class: 'w-compare-cell' }, h('span', { class: 'w-compare-label', text: segment.label }),
        h('span', { class: 'w-compare-value', text: segment.value, dataset: { tone: segment.tone || '' } })));
      const part = h('span', { class: 'w-compare-seg', dataset: { tone: segment.tone || 'neutral' } });
      part.style.width = (segment.fraction * 100) + '%';
      bar.append(part);
    }
    el.append(labels, bar);
  } else if (node.type === 'sparkline') {
    el.dataset.tone = node.tone || 'info';
    if (node.axis) el.append(h('div', { class: 'w-sparkline-axis' }, node.axis.map((text) => h('span', { text }))));
    const cols = h('div', { class: 'w-sparkline-cols' });
    for (const point of node.points) {
      const fill = h('span', { class: 'w-sparkline-fill', dataset: { sign: point < 0 ? 'neg' : 'pos' } });
      fill.style.height = (Math.abs(point) * 50) + '%';
      cols.append(h('span', { class: 'w-sparkline-col' }, fill));
    }
    el.append(cols);
  } else if (node.type === 'list') {
    el.dataset.style = node.style || 'bullet';
    el.append(...node.items.map((text) => h('li', { text })));
  } else if (node.type === 'section') {
    if (node.icon) el.append(overlayIcon(node.icon));
    el.append(h('span', { class: 'w-section-title', text: node.title }));
    if (node.action) el.append(h('span', { class: 'w-section-action', text: node.action }));
  } else if (node.type === 'event') {
    el.dataset.tone = node.tone || 'info';
    el.append(h('span', { class: 'w-event-time', text: node.time }), h('span', { class: 'w-event-mark' }, node.icon && overlayIcon(node.icon)),
      h('span', { class: 'w-event-text', text: node.text }));
  } else if (node.type === 'stat') {
    el.dataset.tone = node.tone || 'accent';
    const fill = h('span', { class: 'w-stat-fill' });
    fill.style.width = (node.fraction * 100) + '%';
    el.append(h('span', { class: 'w-stat-label', text: node.label }), h('span', { class: 'w-stat-left', text: node.left }),
      h('span', { class: 'w-stat-bar' }, fill), h('span', { class: 'w-stat-right', text: node.right }));
  } else if (node.type === 'status') {
    el.append(h('span', { class: 'w-status-label', text: node.label }),
      h('span', { class: 'w-status-state', text: node.state[0].toUpperCase() + node.state.slice(1) }));
    if (node.detail) el.append(h('span', { class: 'w-status-detail', text: node.detail }));
  } else if (node.type === 'meta') {
    el.append(...node.items.map((item) => h('div', { class: 'w-meta-cell' }, h('span', { class: 'w-meta-label', text: item.label }),
      h('span', { class: 'w-meta-value' }, item.value, item.icon && overlayIcon(item.icon)))));
  }
  return el;
}

// A 16:9 stage holding a 1920×1080 screen scaled to the stage's width, so the TV stylesheet's pixel values apply as they are.
let stageWatcher = null;
// Like overlay.js fitPanels(): side panels start below a top bar and end above a bottom bar.
function fitTvPanels(screen) {
  const cards = [...screen.children];
  const bar = (pos) => cards.find((card) => card.dataset.pos === pos);
  const inset = { top: bar('top') ? bar('top').offsetHeight + 'px' : '', bottom: bar('bottom') ? bar('bottom').offsetHeight + 'px' : '' };
  for (const side of ['left', 'right']) {
    const panel = bar(side);
    if (panel) { panel.style.top = inset.top; panel.style.bottom = inset.bottom; }
  }
}
function renderTvStage(stage, card) {
  const theme = { ...card.theme, ...card.timeline?.[Math.min(studioFrame, card.timeline.length - 1)].card.theme };
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
  for (const prop of ['--tv-surface', '--tv-accent', '--tv-fg', '--tv-fg-2', '--tv-line', '--tv-radius', '--tv-scale']) stage.style.removeProperty(prop);
  if (theme.surface || theme.opacity !== undefined) stage.style.setProperty('--tv-surface', `rgb(${rgb(theme.surface || '#191c22')} / ${theme.opacity ?? 0.94})`);
  for (const [key, prop] of [['accent', '--tv-accent'], ['text', '--tv-fg'], ['muted', '--tv-fg-2'], ['line', '--tv-line']]) {
    if (theme[key]) stage.style.setProperty(prop, theme[key]);
  }
  if (theme.radius !== undefined) stage.style.setProperty('--tv-radius', theme.radius + 'px');
  if (theme.scale !== undefined) stage.style.setProperty('--tv-scale', String(theme.scale));
  stage.dataset.font = theme.font || 'sans';
  const screen = h('div', { class: 'tv-screen' }, overlayRegions(card).map((region, index) => {
    const article = h('article', { class: 'tv-card', dataset: { pos: region.position || 'top-right', size: region.size || 'm' } },
      h('div', { class: 'root' }, previewOverlayNode(region.root)));
    studioPositionRegion(article, stage.id === 'ov-preview' ? overlayRegions()[index] : region, stage);
    return article;
  }));
  screen.dataset.edges = overlayRegions(card).map(region => region.position).filter(position => ['top', 'bottom', 'left', 'right'].includes(position)).join(' ');
  stage.replaceChildren(screen);
  fitTvPanels(screen);
  studioFitTickers(screen);
  if (typeof ResizeObserver === 'undefined' || stage.dataset.watched) return;
  stageWatcher ??= new ResizeObserver((entries) => {
    for (const entry of entries) {  // also refits panels: a bar measures 0 while the view is still hidden
      entry.target.style.setProperty('--tv-zoom', String(entry.contentRect.width / 1920));
      if (entry.target.firstElementChild) fitTvPanels(entry.target.firstElementChild);
      if (entry.target.firstElementChild) studioFitTickers(entry.target.firstElementChild);
    }
  });
  stage.dataset.watched = 'true';
  stageWatcher.observe(stage);
}

function tickOverlayPreview() {
  if (document.hidden || S.view !== 'show') return;
  const pad = (value) => String(value).padStart(2, '0');
  for (const clock of document.querySelectorAll('.tv-stage [data-target]')) {
    const seconds = Math.max(0, Math.floor((Date.parse(clock.dataset.target) - Date.now()) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    clock.textContent = days ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`
      : hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
  }
  const now = new Date();
  for (const face of document.querySelectorAll('.tv-stage [data-format]')) {
    face.textContent = face.dataset.format === 'date' ? now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
      : `${pad(now.getHours())}:${pad(now.getMinutes())}${face.dataset.format === 'seconds' ? ':' + pad(now.getSeconds()) : ''}`;
  }
}

function updateOverlayDraft(rebuild) {
  studioRecordDraft();
  overlayJsonDirty = false;
  const body = overlayBody();
  $('ov-json').value = JSON.stringify(body, null, 2);
  $('ov-json').removeAttribute('aria-invalid');
  try { checkOverlayCard(body); overlayError = ''; } catch (err) { overlayError = err.message; }
  if (rebuild) {
    $('ov-layout').value = 'regions' in studioWorkingCard() ? 'regions' : 'single';
    $('ov-card-seconds').value = overlayCard.seconds ?? '';
    overlayCard.theme ??= {};
    const lookCard = studioWorkingCard(), theme = studioVisibleTheme();
    $('ov-look-form').replaceChildren(themeForm(theme, () => { lookCard.theme = theme; updateOverlayDraft(false); }));
    renderOverlayBuilder();
    renderStudioExtras();
  }
  const summary = $('ov-builder').querySelector('.widget-select[aria-pressed="true"] small');
  if (summary) summary.textContent = overlayNodeSummary(overlaySelected);
  const msg = $('ov-builder-msg');
  if (overlayError) result(msg, overlayError, 'error'); else msg.hidden = true;
  if (overlayError) $('ov-preview').replaceChildren(h('p', { class: 'tv-empty', text: 'Complete the widget fields to see your preview.' }));
  else renderTvStage($('ov-preview'), body);
  $('ov-unsaved').hidden = !overlayDirty();
  const size = new TextEncoder().encode(JSON.stringify(body)).length, count = overlayCardCount(body);
  $('ov-meter').value = Math.max(count / OVERLAY_MAX_NODES, size / OVERLAY_MAX_BYTES);
  $('ov-meter-text').textContent = `${count} / ${OVERLAY_MAX_NODES} widgets · ${size.toLocaleString()} / ${OVERLAY_MAX_BYTES.toLocaleString()} bytes`;
  tickOverlayPreview();
  syncNotify();
  studioQueueLive();
}

function setOverlayCard(card) {
  overlayCard = card;
  studioFrame = 0;
  overlaySelected = overlayRegions()[0].root;
  overlayLoaded = JSON.stringify(overlayBody());
  updateOverlayDraft(true);
}

// Confirm in place: a question with Keep it / <verb> appended to `host`; only one open at a time.
function askInPlace(host, question, verb, go) {
  if (overlayAsk) overlayAsk.remove();
  const keep = h('button', { class: 'btn', type: 'button', text: 'Keep it' });
  const yes = h('button', { class: 'btn danger-fill', type: 'button', text: verb });
  const ask = h('div', { class: 'app-confirm' }, h('p', { text: question }), keep, yes);
  overlayAsk = ask;
  keep.addEventListener('click', () => { ask.remove(); overlayAsk = null; });
  yes.addEventListener('click', () => { ask.remove(); overlayAsk = null; go(); });
  host.append(ask);
  keep.focus();
}

function askReplaceDraft(host, what, go) {
  if (overlayDirty() || overlayJsonDirty) askInPlace(host, `Replace your draft with ${what}? Changes you have not saved will be lost.`, 'Replace', go);
  else go();
}

function renderOverlayTemplates() {
  $('ov-templates').replaceChildren(...overlayTemplates().map((template) => {
    const stage = h('div', { class: 'tv-stage tv-thumb', 'aria-hidden': 'true' });
    renderTvStage(stage, template.card);
    const btn = h('button', { class: 'overlay-template', type: 'button', 'aria-label': `Start from the ${template.name} template` },
      stage, h('strong', { text: template.name }), h('span', { class: 'hint', text: template.blurb }));
    btn.addEventListener('click', () => askReplaceDraft($('ov-templates'), `the ${template.name} template`, () => {
      setOverlayCard(clone(template.card)); showStudioStep('design');
    }));
    return btn;
  }));
}

function designSummary(card) {
  const regions = overlayRegions(card);
  const count = overlayCardCount(card);
  return `${'regions' in card ? regions.length + ' regions' : 'Single card'} · ${regions.map((r) => OVERLAY_POSITIONS[r.position || 'top-right']).join(', ')}`
    + ` · ${count} widget${count === 1 ? '' : 's'} · ${card.seconds === 0 ? 'stays until hidden' : (card.seconds ?? 8) + ' s'}`;
}

async function saveDesign() {
  const name = $('design-name').value.trim();
  const msg = $('design-save-msg');
  if (automationBusy.has('designs') || overlayValidationBusy) return;
  if (!name || [...name].length > 60) return result(msg, 'Give the design a name of 1–60 characters first.', 'error');
  if (overlayError || overlayJsonDirty) return result(msg, 'Fix the card (or apply your JSON edits) before saving.', 'error');
  const go = async () => {
    const body = overlayBody();
    if (await changeAutomation('designs', $('design-save'), 'PUT', '/api/designs/' + encodeURIComponent(name), body, `Saved ${name}.`)) {
      overlayLoaded = JSON.stringify(body);
      $('ov-unsaved').hidden = true;
      result(msg, `Saved ${name}. You can find it in My designs below.`, 'ok');
      await loadAutomation('designs');
    } else {
      result(msg, $('designs-msg').textContent, 'error');
    }
  };
  if (automationData.designs && Object.hasOwn(automationData.designs, name)) askInPlace($('design-form'), `Replace the saved design ${name}?`, 'Replace', go);
  else go();
}

function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = h('a', { href: url, download: name + '.json', hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportDesign() {
  downloadJson(studioBundle(overlayBody(), $('design-name').value.trim() || 'card'), $('design-name').value.trim() || 'card');
}

async function importDesign(file) {
  if (file) await studioImport(file);
}

function wireOverlayBuilder() {
  renderOverlayTemplates();
  updateOverlayDraft(true);
  showStudioStep('start');
  wireStudioExtras();
  for (const button of document.querySelectorAll('[data-studio-step]')) {
    button.addEventListener('click', () => showStudioStep(button.dataset.studioStep));
  }
  $('ov-layout').addEventListener('change', () => {
    const multi = $('ov-layout').value === 'regions';
    const change = () => {
      const layoutCard = studioWorkingCard();
      studioCaptureBindingAnchors();
      if (multi && !('regions' in layoutCard)) {
        layoutCard.regions = [{ position: layoutCard.position || 'top-right', size: layoutCard.size || 'm', root: layoutCard.root,
          ...(layoutCard.offset ? { offset: layoutCard.offset } : {}), ...(layoutCard.animation ? { animation: layoutCard.animation } : {}) }];
        delete layoutCard.position; delete layoutCard.size; delete layoutCard.root; delete layoutCard.offset; delete layoutCard.animation;
      } else if (!multi && 'regions' in layoutCard) {
        Object.assign(layoutCard, layoutCard.regions[0]);
        delete layoutCard.regions;
      }
      studioRebaseBindings();
      updateOverlayDraft(true);
    };
    if (!multi && studioWorkingCard().regions?.length > 1) {
      $('ov-layout').value = 'regions';
      askInPlace($('ov-panel-design'), 'Keep only the first area? The other areas and their widgets will be removed.', 'Use one card', change);
    } else change();
  });
  $('ov-look-presets').replaceChildren(...Object.entries(OVERLAY_LOOKS).map(([name, theme]) =>
    h('button', { class: 'look-preset btn', type: 'button', text: name, dataset: { preset: name.toLowerCase().replaceAll(' ', '-') },
      onclick: () => studioApplyLook(theme) })));
  $('ov-card-seconds').addEventListener('input', () => {
    const value = $('ov-card-seconds').value;
    if (value === '') delete overlayCard.seconds; else overlayCard.seconds = Number(value);
    updateOverlayDraft(false);
  });
  $('ov-json').addEventListener('input', () => {
    overlayJsonDirty = true;
    result($('ov-json-msg'), 'Your JSON has changed. Apply it to update the preview, or discard your edits.');
    syncNotify();
  });
  $('ov-json-apply').addEventListener('click', () => applyOverlayJson($('ov-json')));
  $('ov-json').addEventListener('blur', () => { if (overlayJsonDirty) applyOverlayJson($('ov-json')); });
  $('ov-paste-apply').addEventListener('click', () => {
    askReplaceDraft($('ov-panel-start'), 'the pasted card', () => applyOverlayJson($('ov-paste'), $('ov-paste-msg')));
  });
  $('ov-ai-copy').addEventListener('click', async () => {
    try { await copyText(overlayAiPrompt()); result($('ov-ai-msg'), 'Prompt copied. Paste it into your assistant and replace the last request with your idea.', 'ok'); }
    catch { result($('ov-ai-msg'), 'Copy was blocked. Try again from a browser that allows clipboard access.', 'error'); }
  });
  const schemaAction = async (download) => {
    const button = $(download ? 'ov-schema-download' : 'ov-schema-copy');
    if (button.disabled) return;
    button.disabled = true;
    button.dataset.state = 'loading';
    try {
      const schema = await fetchOverlaySchema();
      if (download) downloadJson(schema, 'tv-card-schema'); else await copyText(JSON.stringify(schema, null, 2));
      result($('ov-ai-msg'), download ? 'Schema downloaded.' : 'JSON Schema copied.', 'ok');
    } catch (err) { result($('ov-ai-msg'), err.message, 'error'); }
    finally { button.disabled = false; delete button.dataset.state; }
  };
  $('ov-schema-copy').addEventListener('click', () => schemaAction(false));
  $('ov-schema-download').addEventListener('click', () => schemaAction(true));
  $('ov-ai').addEventListener('toggle', () => { if ($('ov-ai').open) fetchOverlaySchema().catch(err => result($('ov-ai-msg'), err.message, 'error')); });
  $('design-copy').addEventListener('click', async () => {
    try { await copyText(JSON.stringify(studioRedact(overlayBody()), null, 2)); result($('design-save-msg'), 'Card JSON copied without saved credentials.', 'ok'); }
    catch { result($('design-save-msg'), 'Copy was blocked. Export JSON instead.', 'error'); }
  });
  $('ov-json-reset').addEventListener('click', () => updateOverlayDraft(false));
  setInterval(tickOverlayPreview, 1000);
  $('ov-send').addEventListener('click', () => { if (!$('ov-send').disabled) sendOverlay(overlayBody(), $('ov-send')); });
  $('design-form').addEventListener('submit', (e) => { e.preventDefault(); saveDesign(); });
  $('design-export').addEventListener('click', () => exportDesign());
  $('design-import').addEventListener('click', () => $('design-import-file').click());
  $('design-import-file').addEventListener('change', (e) => { importDesign(e.target.files[0]); e.target.value = ''; });
}

function syncOverlay(off) {
  const card = cardFromForm();
  const blocked = off || S.reserved || S.overlayBusy;
  for (const button of document.querySelectorAll('[data-overlay-send]')) button.disabled = blocked;
  $('ov-show').disabled = blocked || !(card.title || card.body || card.lines);
  $('ov-send').disabled = blocked || !!overlayError || overlayJsonDirty || overlayValidationBusy;
  $('ov-hide').disabled = blocked;
  $('ov-details').disabled = blocked;
  $('ov-panel-design').inert = overlayJsonDirty || overlayValidationBusy;
  $('ov-widget-editor').inert = overlayJsonDirty || overlayValidationBusy;
  $('design-save').disabled = !!overlayError || overlayJsonDirty || overlayValidationBusy || automationBusy.has('designs');
  $('design-export').disabled = $('design-copy').disabled = !!overlayError || overlayJsonDirty || overlayValidationBusy;
  $('overlay-hint').textContent = off ? 'In standby: turn the TV on first' : S.reserved ? 'Reserved by processing' : '';
}

async function sendOverlay(card, btn) {
  const msg = $(btn.id === 'ov-send' || btn.id === 'ov-hide' ? 'ov-send-msg' : 'overlay-msg');
  if (S.overlayBusy) return;
  studioCancelLive(card.hide === true || btn.id !== 'ov-send');
  if (card.seconds !== undefined && !(Number.isInteger(card.seconds) && card.seconds >= 0 && card.seconds <= 300)) {
    return result(msg, 'Seconds must be a whole number from 0 to 300', 'error');
  }
  if ((card.root || card.regions) && new TextEncoder().encode(JSON.stringify(card)).length > OVERLAY_MAX_BYTES) {
    return result(msg, `Use at most ${OVERLAY_MAX_BYTES} bytes of JSON for the whole card.`, 'error');
  }
  S.overlayBusy = true;
  if (card.bindings) {
    try { card = (await call('POST', '/api/designs/resolve', { json: card })).card; }
    catch (err) { S.overlayBusy = false; syncNotify(); return result(msg, err.message, 'error'); }
  }
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
  studioQueueLive();
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

/* ---------- scenes, local schedules and webhook links ---------- */

const AUTOMATION = {
  scenes: { group: 'Scenes', key: 'scenes', empty: 'No scenes yet. Save your first sequence below.' },
  schedule: { group: 'Schedule', key: 'entries', empty: 'No schedules yet. Add a time for a scene below.' },
  webhooks: { group: 'Webhooks', key: 'webhooks', empty: 'No webhook links yet. Create a private link below.' },
  addons: { group: 'Addons' },
  designs: { group: 'Designs', key: 'designs', empty: 'No saved designs yet. Name your draft and save it.', view: 'show' },
};
const automationKinds = (view) => Object.keys(AUTOMATION).filter((kind) => (AUTOMATION[kind].view || 'automate') === view);
const automationData = { scenes: null, schedule: null, webhooks: null, addons: null, designs: null };
const automationBusy = new Set();

async function loadAutomation(kind) {
  const config = AUTOMATION[kind];
  if (!supports({ group: config.group }) || automationBusy.has(kind)) return;
  automationBusy.add(kind);
  const list = $(kind + '-list');
  const refresh = $(kind + '-refresh');
  const controls = [...list.closest('.panel').querySelectorAll('button, input, textarea, select')].map(el => [el, el.disabled]);
  for (const [el] of controls) el.disabled = true;
  refresh.disabled = true;
  refresh.dataset.state = 'loading';
  list.setAttribute('aria-busy', 'true');
  if (!automationData[kind]) list.replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));
  try {
    const reply = await call('GET', '/api/' + kind);
    automationData[kind] = config.key ? reply[config.key] : reply;
    renderAutomation(kind);
  } catch (err) {
    list.replaceChildren(h('p', { class: 'empty', dataset: { tone: 'error' },
      text: 'Could not load this list: ' + err.message + '. ' },
    h('button', { class: 'btn quiet', type: 'button', text: 'Try again', onclick: () => loadAutomation(kind) })));
  } finally {
    automationBusy.delete(kind);
    refresh.disabled = false;
    delete refresh.dataset.state;
    list.setAttribute('aria-busy', 'false');
    for (const [el, disabled] of controls) el.disabled = disabled;
  }
}

function renderAutomation(kind) {
  if (kind === 'addons') return renderAddons();
  const entries = Object.entries(automationData[kind]);
  $(kind + '-list').replaceChildren(entries.length
    ? h('ul', { class: kind === 'designs' ? 'design-grid' : 'app-list automation-list' }, entries.map(([id, entry]) => automationRow(kind, id, entry)))
    : h('p', { class: 'empty', text: AUTOMATION[kind].empty }));
  if (kind === 'scenes' || kind === 'designs') {
    $(kind === 'scenes' ? 'automation-scenes' : 'design-names').replaceChildren(...entries.map(([name]) => h('option', { value: name })));
  }
}

function renderAddons() {
  const { catalog, installed } = automationData.addons;
  $('addons-list').replaceChildren(catalog.length
    ? h('ul', { class: 'app-list addon-list' }, catalog.map(addon => addonCard(addon, installed[addon.id])))
    : h('p', { class: 'empty', text: 'No extensions are available from this server.' }));
}

function addonCard(addon, entry) {
  const card = h('li', { class: 'app addon-card' });
  card.append(h('div', { class: 'app-meta' }, h('h3', { text: addon.name }),
    h('span', { text: addon.description }),
    h('span', { text: `${addon.category} · ${entry ? entry.enabled ? 'Installed · Enabled' : 'Installed · Disabled' : 'Not installed'}` })));
  const form = h('form', { class: 'stack-form', 'aria-label': 'Settings for ' + addon.name });
  const fields = [];
  for (const spec of addon.params_schema) {
    const input = studioMetadataInput(spec, entry?.params?.[spec.key]);
    fields.push([spec.key, input, spec.type]);
    form.append(h('label', { class: spec.type === 'boolean' ? 'check' : 'field' }, spec.label, input,
      spec.description && h('span', { class: 'hint', text: spec.description })));
  }
  const interval = h('input', { type: 'number', min: 15, max: 3600, step: 1, required: true,
    value: entry?.interval_seconds ?? addon.default_interval_seconds });
  form.append(h('label', { class: 'field' }, 'Refresh every (seconds, 15–3600)', interval));
  const position = h('select', {}, Object.entries(OVERLAY_POSITIONS).map(([value, text]) => h('option', { value, text, selected: value === (entry?.position || 'top-right') })));
  const size = h('select', {}, Object.entries(OVERLAY_SIZES).map(([value, text]) => h('option', { value, text, selected: value === (entry?.size || 'm') })));
  form.append(h('div', { class: 'pair' }, h('label', { class: 'field' }, 'Position on the TV', position), h('label', { class: 'field' }, 'Size', size)));
  const theme = { ...entry?.theme };
  form.append(h('details', { class: 'addon-look', open: Object.keys(theme).length > 0 }, h('summary', { text: 'Look' }),
    themeForm(theme, () => {}, ['accent', 'surface', 'opacity'])));
  const params = () => Object.fromEntries(fields.map(([key, input, type]) =>
    [key, type === 'boolean' ? input.checked : type === 'number' ? Number(input.value) : input.value]));
  const path = '/api/addons/' + encodeURIComponent(addon.id);
  const save = h('button', { class: 'btn primary', type: 'submit', text: entry ? 'Update' : 'Install',
    'aria-label': (entry ? 'Update ' : 'Install ') + addon.name });
  const preview = h('button', { class: 'btn quiet', type: 'button', text: 'Preview on TV', 'aria-label': 'Preview ' + addon.name + ' on TV' });
  preview.addEventListener('click', () => changeAutomation('addons', preview, 'POST', path + '/preview', { params: params() }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (await changeAutomation('addons', save, 'PUT', path, { ...entry, params: params(), interval_seconds: Number(interval.value), enabled: entry ? entry.enabled : true,
      position: position.value, size: size.value, theme: Object.keys(theme).length ? theme : undefined })) await loadAutomation('addons');
  });
  form.append(h('div', { class: 'row' }, save, preview));
  card.append(form);
  if (entry) {
    const toggle = h('button', { class: 'btn', type: 'button', text: entry.enabled ? 'Disable' : 'Enable',
      'aria-label': (entry.enabled ? 'Disable ' : 'Enable ') + addon.name, 'aria-pressed': String(entry.enabled) });
    toggle.addEventListener('click', async () => {
      if (await changeAutomation('addons', toggle, 'PUT', path, { ...entry, enabled: !entry.enabled },
        entry.enabled ? 'Extension disabled.' : 'Extension enabled.')) await loadAutomation('addons');
    });
    const remove = h('button', { class: 'btn danger', type: 'button', text: 'Uninstall', 'aria-label': 'Uninstall ' + addon.name });
    remove.addEventListener('click', () => askAutomationDelete('addons', addon.id, addon.name, card, remove));
    card.append(h('div', { class: 'row' }, toggle, remove));
  }
  return card;
}

async function changeAutomation(kind, btn, method, path, json, message) {
  if (automationBusy.has(kind)) return;
  automationBusy.add(kind);
  const panel = $(kind + '-list').closest('.panel');
  const controls = [...new Set([btn, ...panel.querySelectorAll('button, input, textarea, select'),
    ...(btn.closest('.panel')?.querySelectorAll('button, input, textarea, select') || [])])].map(el => [el, el.disabled]);
  for (const [el] of controls) el.disabled = true;
  btn.dataset.state = 'loading';
  try {
    const reply = await call(method, path, { json });
    result($(kind + '-msg'), typeof message === 'function' ? message(reply) : message || reply.message, 'ok');
    return reply;
  } catch (err) {
    result($(kind + '-msg'), err.message, 'error');
  } finally {
    automationBusy.delete(kind);
    delete btn.dataset.state;
    for (const [el, disabled] of controls) el.disabled = disabled;
  }
}

function askAutomationDelete(kind, id, name, row, trigger) {
  if (automationBusy.has(kind) || row.querySelector('.app-confirm')) return;
  trigger.hidden = true;
  const keep = h('button', { class: 'btn', type: 'button', text: 'Keep it' });
  const action = kind === 'addons' ? 'Uninstall' : 'Delete';
  const go = h('button', { class: 'btn danger-fill', type: 'button', text: action });
  const consequence = kind === 'scenes' ? ' Schedules and links using it will no longer run.'
    : kind === 'webhooks' ? ' Anyone using this link will lose access.'
      : kind === 'addons' ? ' Its automatic refresh will stop.'
        : kind === 'designs' ? ' Scenes that show it will stop working.' : '';
  const ask = h('div', { class: 'app-confirm' }, h('p', { text: `${action} ${name}?${consequence}` }), keep, go);
  keep.addEventListener('click', () => { ask.remove(); trigger.hidden = false; trigger.focus(); });
  go.addEventListener('click', async () => {
    if (await changeAutomation(kind, go, 'DELETE', '/api/' + kind + '/' + encodeURIComponent(id), undefined,
      (kind === 'addons' ? 'Uninstalled ' : 'Deleted ') + name + '.')) {
      if (kind === 'scenes' && $('scene-name').readOnly && $('scene-name').value === id) resetSceneForm();
      await loadAutomation(kind);
    }
  });
  row.append(ask);
  keep.focus();
}

function renameDesign(id, entry, row) {
  if (automationBusy.has('designs') || row.querySelector('.design-rename')) return;
  const input = h('input', { type: 'text', value: id, maxlength: 60, required: true, 'aria-label': 'New name' });
  const form = h('form', { class: 'design-rename' }, h('label', { class: 'field' }, 'New name', input));
  const message = h('p', { class: 'result-msg', role: 'status', hidden: true });
  form.append(h('button', { class: 'btn', type: 'submit', text: 'Review rename' }),
    h('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => form.remove() }), message);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name || [...name].length > 60 || name === id) return result(message, 'Choose a different name, using 1–60 characters.', 'error');
    if (automationData.designs && Object.hasOwn(automationData.designs, name)) return result(message, 'That name is already in use. Choose another name.', 'error');
    askInPlace(form, `Rename ${id} to ${name}? Scenes using the old name will need updating.`, 'Rename', async () => {
      const button = form.querySelector('button');
      if (!await changeAutomation('designs', button, 'POST', '/api/designs/' + encodeURIComponent(id) + '/rename', { name })) return;
      if ($('design-name').value === id) $('design-name').value = name;
      await loadAutomation('designs');
      result($('designs-msg'), `Renamed ${id} to ${name}. Saved versions moved with it.`, 'ok');
    });
  });
  row.append(form);
  input.focus();
  input.select();
}

function automationRow(kind, id, entry) {
  const row = h('li', { class: kind === 'designs' ? 'design-tile' : 'app' });
  const name = kind === 'scenes' || kind === 'designs' ? id : kind === 'schedule' ? entry.scene : entry.label || id;
  const summary = kind === 'scenes' ? `${entry.steps.length} step${entry.steps.length === 1 ? '' : 's'}`
    : kind === 'schedule' ? `${entry.time} · ${entry.days.length ? entry.days.map(day => day[0].toUpperCase() + day.slice(1)).join(', ') : 'Every day'} · ${entry.enabled ? 'Enabled' : 'Disabled'}`
      : kind === 'designs' ? designSummary(entry) : (entry.design ? 'Design: ' + entry.design : 'Scene: ' + entry.scene);
  row.append(h('div', { class: 'app-meta' }, h('strong', { text: name }), h('span', { text: summary })));
  const actions = h('div', { class: 'row' });
  if (kind === 'designs') {
    const stage = h('div', { class: 'tv-stage tv-thumb', 'aria-hidden': 'true' });
    renderTvStage(stage, entry);
    row.prepend(stage);
    const load = h('button', { class: 'btn', type: 'button', text: 'Load', 'aria-label': 'Load ' + id + ' into the studio' });
    load.addEventListener('click', () => askReplaceDraft(row, `the saved design ${id}`, () => {
      setOverlayCard(clone(entry)); $('design-name').value = id; showStudioStep('design');
      $('h-studio').scrollIntoView({ block: 'start', behavior: 'instant' });
    }));
    const show = h('button', { class: 'btn', type: 'button', text: 'Show on TV', 'aria-label': 'Show ' + id + ' on TV',
      dataset: { overlaySend: 'true' }, disabled: S.overlayBusy || S.reserved });
    show.addEventListener('click', () => {
      if (S.overlayBusy) return;
      studioCancelLive(true);
      return changeAutomation(kind, show, 'POST', '/api/designs/' + encodeURIComponent(id) + '/show');
    });
    const rename = h('button', { class: 'btn quiet', type: 'button', text: 'Rename', onclick: () => renameDesign(id, entry, row) });
    const exportButton = h('button', { class: 'btn quiet', type: 'button', text: 'Export', onclick: () => studioExportSaved(id) });
    const versions = h('button', { class: 'btn quiet', type: 'button', text: 'Versions', onclick: () => studioVersions(id, row) });
    actions.append(load, show, rename, exportButton, versions);
  } else if (kind === 'scenes') {
    const run = h('button', { class: 'btn', type: 'button', text: 'Run', 'aria-label': 'Run ' + id });
    run.addEventListener('click', () => changeAutomation(kind, run, 'POST', '/api/scenes/' + encodeURIComponent(id) + '/run', undefined,
      reply => `${id}: ${reply.messages.join(' · ') || 'Scene finished.'}`));
    const edit = h('button', { class: 'btn quiet', type: 'button', text: 'Edit', 'aria-label': 'Edit ' + id });
    edit.addEventListener('click', () => {
      $('scene-name').value = id;
      $('scene-name').readOnly = true;
      $('scene-json').value = JSON.stringify(entry, null, 2);
      sceneSteps = clone(entry.steps);
      renderSceneBuilder();
      $('scene-form-title').textContent = 'Edit ' + id;
      $('scene-save').textContent = 'Save changes';
      $('scene-new').hidden = false;
      $('scene-name').focus();
    });
    actions.append(run, edit);
  } else if (kind === 'schedule') {
    const toggle = h('button', { class: 'btn', type: 'button', text: entry.enabled ? 'Disable' : 'Enable',
      'aria-label': (entry.enabled ? 'Disable' : 'Enable') + ' schedule for ' + entry.scene, 'aria-pressed': String(entry.enabled) });
    toggle.addEventListener('click', async () => {
      const { scene, time, days, enabled } = entry;
      if (await changeAutomation(kind, toggle, 'PUT', '/api/schedule/' + encodeURIComponent(id),
        { scene, time, days, enabled: !enabled }, enabled ? 'Schedule disabled.' : 'Schedule enabled.')) await loadAutomation(kind);
    });
    actions.append(toggle);
  } else {
    const url = location.origin + '/webhook/' + encodeURIComponent(id);
    actions.append(copyButton('Copy link', () => url));
    row.append(h('input', { type: 'text', class: 'automation-link', value: url, readonly: true,
      'aria-label': 'Webhook link for ' + name }));
    if (entry.design) row.append(studioWebhookPayload(entry.design, url));
  }
  const remove = h('button', { class: 'btn danger', type: 'button', 'aria-label': 'Delete ' + name }, icon('trash'), h('span', { text: 'Delete' }));
  remove.addEventListener('click', () => askAutomationDelete(kind, id, name, row, remove));
  actions.append(remove);
  row.append(actions);
  return row;
}

const SCENE_TYPES = { remote: 'Press a remote button', overlay: 'Show a card', wait: 'Wait a moment', setting: 'Change a TV setting' };
const SCENE_REMOTE = { wake: 'Turn on', power_off: 'Turn off', home: 'Go Home', back: 'Go back', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', ok: 'OK', hdmi: 'Switch HDMI input', volume_up: 'Volume up', volume_down: 'Volume down', volume: 'Set volume',
  mute: 'Mute', unmute: 'Unmute' };
let sceneSteps = [{ type: 'wait', seconds: 0 }];

function newSceneStep(type) {
  if (type === 'remote') return { type, action: 'home' };
  if (type === 'wait') return { type, seconds: 1 };
  if (type === 'overlay') return { type, design: '' };
  if (type === 'setting') {
    const item = S.settings?.find(setting => setting.available);
    return { type, category: item?.category || 'picture', key: item?.key || 'brightness', value: item?.value ?? 50 };
  }
  throw new Error('Choose a known action type.');
}

function sceneFromSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('A scene needs 1–20 actions.');
  for (const [index, step] of steps.entries()) {
    const fail = (message) => { throw new Error(`Action ${index + 1}: ${message}`); };
    if (!step || !Object.hasOwn(SCENE_TYPES, step.type)) fail('choose a known action type.');
    if (step.type === 'wait' && !inRange(step.seconds, 0, 10)) fail('wait between 0 and 10 seconds.');
    if (step.type === 'remote') {
      if (!Object.hasOwn(SCENE_REMOTE, step.action)) fail('choose a remote button.');
      if (step.action === 'hdmi' && (!Number.isInteger(step.value) || step.value < 1 || step.value > 4)) fail('choose HDMI input 1–4.');
      if (step.action === 'volume' && (!Number.isInteger(step.value) || step.value < 0 || step.value > 100)) fail('choose a volume from 0 to 100.');
    }
    if (step.type === 'setting' && (!step.category || !step.key || !Object.hasOwn(step, 'value'))) fail('choose a setting and its value.');
    if (step.type === 'overlay') {
      if ('design' in step) {
        if (typeof step.design !== 'string' || !step.design.trim() || [...step.design].length > 60) fail('choose a saved design.');
      } else {
        try { checkOverlayCard(step.card); } catch (err) { fail(err.message); }
      }
    }
  }
  return { steps: clone(steps) };
}

function sceneFromJson(text) {
  const scene = JSON.parse(text);
  if (!scene || typeof scene !== 'object' || Array.isArray(scene) || Object.keys(scene).some(key => key !== 'steps')) {
    throw new Error('A scene must be an object containing only its actions as "steps".');
  }
  return sceneFromSteps(scene.steps);
}

function syncSceneJson() {
  $('scene-json').value = JSON.stringify({ steps: sceneSteps }, null, 2);
  try { sceneFromSteps(sceneSteps); $('scenes-msg').hidden = true; }
  catch (err) { result($('scenes-msg'), err.message, 'error'); }
}

function renderSceneBuilder() {
  let host = $('scene-builder');
  if (!host) {
    host = h('div', { id: 'scene-builder', class: 'scene-builder' });
    const disclosure = $('scene-json').closest('details');
    if (disclosure) { disclosure.before(host); disclosure.open = false; }
    else $('scene-json').parentNode.before(host);
  }
  const stepForm = (step, index) => {
    const box = h('li', { class: 'scene-step' });
    const kind = h('select', { 'aria-label': `Action ${index + 1} type` },
      Object.entries(SCENE_TYPES).map(([value, text]) => h('option', { value, text, selected: step.type === value })));
    kind.addEventListener('change', () => {
      sceneSteps[index] = newSceneStep(kind.value); syncSceneJson(); renderSceneBuilder();
      if (kind.value === 'setting' && !S.settings) loadSettings().then(renderSceneBuilder);
    });
    box.append(h('div', { class: 'row' }, h('strong', { text: `Action ${index + 1}` }), h('label', { class: 'field' }, 'What should happen?', kind)));
    const fields = h('div', { class: 'pair' });
    const inputField = (label, key, attrs = {}) => {
      const input = h('input', { type: 'text', value: step[key] ?? '', ...attrs });
      input.addEventListener('input', () => {
        step[key] = attrs.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
        if (key === 'value' && step.type === 'setting') {
          try { step.value = JSON.parse(input.value); } catch { step.value = input.value; }
        }
        syncSceneJson();
      });
      fields.append(h('label', { class: 'field' }, label, input));
    };
    if (step.type === 'wait') {
      inputField('Seconds to wait', 'seconds', { type: 'number', min: 0, max: 10, step: 0.1, required: true });
    } else if (step.type === 'remote') {
      const actions = S.api?.routes?.find(route => route.path === '/api/remote/{action}')?.values?.map(action => action.name) || Object.keys(SCENE_REMOTE);
      const action = h('select', { 'aria-label': 'Remote button' }, actions.map(value => h('option', {
        value, text: SCENE_REMOTE[value] || value, selected: value === step.action })));
      action.addEventListener('change', () => {
        step.action = action.value;
        if (step.action === 'hdmi') step.value = 1; else if (step.action === 'volume') step.value = 20; else delete step.value;
        syncSceneJson(); renderSceneBuilder();
      });
      fields.append(h('label', { class: 'field' }, 'Remote button', action));
      if (step.action === 'hdmi') inputField('HDMI input', 'value', { type: 'number', min: 1, max: 4, step: 1, required: true });
      if (step.action === 'volume') inputField('Volume (0–100)', 'value', { type: 'number', min: 0, max: 100, step: 1, required: true });
    } else if (step.type === 'overlay') {
      const mode = h('select', { 'aria-label': 'Card source' }, h('option', { value: 'design', text: 'A saved design', selected: 'design' in step }),
        h('option', { value: 'card', text: 'Paste card JSON', selected: !('design' in step) }));
      mode.addEventListener('change', () => {
        delete step.design; delete step.card;
        if (mode.value === 'design') step.design = ''; else step.card = { root: { type: 'text', text: 'Your message' } };
        syncSceneJson(); renderSceneBuilder();
      });
      fields.append(h('label', { class: 'field' }, 'Card to show', mode));
      if ('design' in step) inputField('Design name', 'design', { list: 'design-names', maxlength: 60, required: true, placeholder: 'Name from My designs' });
      else {
        const input = h('textarea', { rows: 5, spellcheck: false, 'aria-label': 'Card JSON', value: JSON.stringify(step.card, null, 2) });
        input.value = JSON.stringify(step.card, null, 2);
        input.addEventListener('input', () => {
          try { step.card = parseOverlayPaste(input.value); input.removeAttribute('aria-invalid'); }
          catch { step.card = input.value; input.setAttribute('aria-invalid', 'true'); }
          syncSceneJson();
        });
        fields.append(h('label', { class: 'field' }, 'Card JSON', input));
      }
    } else if (step.type === 'setting') {
      const known = (S.settings || []).filter(item => item.available);
      if (known.length) {
        const setting = h('select', { 'aria-label': 'TV setting' }, known.map(item => h('option', {
          value: item.category + '.' + item.key, text: (CATEGORY[item.category] || item.category) + ' · ' + item.label,
          selected: item.category === step.category && item.key === step.key,
        })));
        setting.addEventListener('change', () => {
          const item = known.find(item => item.category + '.' + item.key === setting.value);
          Object.assign(step, { category: item.category, key: item.key, value: item.value }); delete step.context;
          syncSceneJson(); renderSceneBuilder();
        });
        fields.append(h('label', { class: 'field' }, 'TV setting', setting));
        const item = known.find(item => item.category === step.category && item.key === step.key);
        if (item?.values?.length) {
          const values = item.values.includes(step.value) ? item.values : [step.value, ...item.values];
          const value = h('select', { 'aria-label': 'Setting value' }, values.map(option => h('option', {
            value: JSON.stringify(option), text: String(option), selected: option === step.value,
          })));
          value.addEventListener('change', () => { step.value = JSON.parse(value.value); syncSceneJson(); });
          fields.append(h('label', { class: 'field' }, 'Set to', value));
        } else inputField('Set to', 'value');
      } else {
        fields.append(h('p', { class: 'hint', text: 'Turn on the TV and open Tune to load its available settings. You can also enter a setting below.' }));
        inputField('Category', 'category', { required: true });
        inputField('Setting name', 'key', { required: true });
        inputField('Set to', 'value', { required: true });
      }
    }
    const tool = (text, disabled, act) => h('button', { class: 'btn quiet', type: 'button', text, disabled,
      'aria-label': `${text} action ${index + 1}`, onclick: () => { act(); syncSceneJson(); renderSceneBuilder(); } });
    box.append(fields, h('div', { class: 'row overlay-tools' },
      tool('Move up', index === 0, () => sceneSteps.splice(index - 1, 2, step, sceneSteps[index - 1])),
      tool('Move down', index === sceneSteps.length - 1, () => sceneSteps.splice(index, 2, sceneSteps[index + 1], step)),
      tool('Remove', sceneSteps.length === 1, () => sceneSteps.splice(index, 1))));
    return box;
  };
  host.replaceChildren(h('h4', { text: 'Actions, in order' }), h('ol', { class: 'scene-steps' }, sceneSteps.map(stepForm)),
    h('button', { class: 'btn', type: 'button', text: 'Add an action', disabled: sceneSteps.length >= 20, onclick: () => {
      sceneSteps.push(newSceneStep('remote')); syncSceneJson(); renderSceneBuilder();
    } }));
}

function resetSceneForm() {
  $('scene-form').reset();
  $('scene-name').readOnly = false;
  $('scene-form-title').textContent = 'Save a scene';
  $('scene-save').textContent = 'Save scene';
  $('scene-new').hidden = true;
  sceneSteps = [{ type: 'wait', seconds: 0 }];
  syncSceneJson();
  renderSceneBuilder();
}

function wireAutomation() {
  for (const kind of Object.keys(AUTOMATION)) $(kind + '-refresh').addEventListener('click', () => loadAutomation(kind));
  renderSceneBuilder();
  $('scene-json').addEventListener('blur', () => {
    try {
      sceneSteps = sceneFromJson($('scene-json').value).steps;
      renderSceneBuilder(); $('scenes-msg').hidden = true;
    } catch (err) { result($('scenes-msg'), 'Scene code not applied: ' + err.message, 'error'); }
  });
  $('scene-new').addEventListener('click', resetSceneForm);
  $('scene-form').addEventListener('submit', async event => {
    event.preventDefault();
    let scene;
    try { scene = sceneFromJson($('scene-json').value); }
    catch (err) { return result($('scenes-msg'), 'Check your scene: ' + err.message, 'error'); }
    if (await changeAutomation('scenes', $('scene-save'), 'PUT', '/api/scenes/' + encodeURIComponent($('scene-name').value), scene)) {
      await loadAutomation('scenes');
    }
  });
  $('schedule-form').addEventListener('submit', async event => {
    event.preventDefault();
    const body = { scene: $('schedule-scene').value, time: $('schedule-time').value,
      days: [...document.querySelectorAll('#schedule-form input[name="day"]:checked')].map(el => el.value), enabled: true };
    if (await changeAutomation('schedule', $('schedule-save'), 'POST', '/api/schedule', body)) {
      $('schedule-form').reset();
      await loadAutomation('schedule');
    }
  });
  $('webhook-form').addEventListener('submit', async event => {
    event.preventDefault();
    const reply = await changeAutomation('webhooks', $('webhook-save'), 'POST', '/api/webhooks',
      { [$('webhook-target-type').value]: $('webhook-scene').value, label: $('webhook-label').value });
    if (reply) {
      $('webhook-form').reset();
      await loadAutomation('webhooks');
      const message = $('webhooks-msg');
      message.append(' ', copyButton('Copy new link', () => location.origin + reply.url));
    }
  });
}

/* ---------- views, keyboard, startup ---------- */

function showView(view) {
  if (!VIEWS.has(view)) view = 'home';
  if (studioRole === 'guest' && !['remote', 'settings'].includes(view)) view = 'remote';
  S.view = view;
  for (const el of document.querySelectorAll('.view')) el.hidden = el.dataset.viewId !== view;
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (view !== 'show') stopLive();  // the live picture is private: it must not keep streaming into a hidden page
  if (view !== 'show') { studioClearSnapshot(); studioCancelLive(true); }
  if (view === 'apps' && S.api) loadApps();
  if ((view === 'automate' || view === 'show') && S.api) for (const kind of automationKinds(view)) loadAutomation(kind);
  if (location.hash !== '#' + view) history.replaceState(null, '', view === 'home' ? location.pathname : '#' + view);
  if (view === 'settings') studioLoadUsers();
  if (view === 'automate') studioLoadRotations();
  if (view === 'show') studioLoadThemes();
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
  wireAutomation();
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
  wireRemoteVolume();
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
  setInterval(() => { if (!document.hidden && !S.statusBusy && !studioEventsHealthy()) loadStatus(true); }, 10000);
  setInterval(() => { if (S.job && ACTIVE.has(S.job.state)) renderElapsed(); }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopLive(); studioClearSnapshot(); studioCancelLive(true); studioStopEvents(); }
    else { if (!studioEventsHealthy()) loadStatus(true); studioStartEvents(); }
  });
  setInterval(() => { if (!document.hidden && studioRole !== 'guest') loadDetails(true); }, 60000);
  $('refresh-details').addEventListener('click', () => loadDetails());
  $('notify-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('toast').disabled) sendNotify('toast', $('toast')); });
  $('speak').addEventListener('click', (e) => sendNotify('say', e.currentTarget));
  $('notify-text').addEventListener('input', syncNotify);
  $('notify-volume').addEventListener('input', (e) => { $('notify-volume-out').textContent = e.target.value; });
  $('shot-capture').addEventListener('click', capture);
  $('live-start').addEventListener('click', startLive);
  $('live-stop').addEventListener('click', stopLive);
  window.addEventListener('pagehide', () => { stopLive(); studioClearSnapshot(); studioCancelLive(true); studioStopEvents(); });
  window.addEventListener('pageshow', () => { if (!document.hidden) studioStartEvents(); });
  wireOverlayBuilder();
  $('overlay-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('ov-show').disabled) sendOverlay(cardFromForm(), $('ov-show')); });
  $('ov-hide').addEventListener('click', (e) => sendOverlay({ hide: true }, e.currentTarget));
  $('ov-details').addEventListener('click', (e) => showDetailsCard(e.currentTarget));
  for (const id of ['ov-title', 'ov-body', 'ov-lines']) $(id).addEventListener('input', syncNotify);
}

async function loadAll() {
  if (studioRole === 'guest') { await loadStatus(); return; }
  if (S.view === 'automate' || S.view === 'show') for (const kind of automationKinds(S.view)) loadAutomation(kind);
  if (S.view === 'show') studioLoadThemes();
  if (S.view === 'automate') studioLoadRotations();
  if (S.view === 'settings') studioLoadUsers();
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
  studioStartEvents();
}

async function start() {
  S.token = readToken();
  wire();
  wireExtras();
  renderTheme();
  renderDevice();
  showView(location.hash.slice(1));
  if (studioRole === 'guest') { S.paired = true; await loadStatus(); return; }
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
  studioStartEvents();
}

document.addEventListener('DOMContentLoaded', start);
