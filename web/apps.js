'use strict';
// Apps (list, push, uninstall), the login setting, and first-run pairing help.
// Shares h, $, call, say, result, supports, copyText and friends with app.js; both scripts are loaded before start() runs.

const INSTALL_BUDGET_S = 90;  // the longest the TV side waits for an install (ARCHITECTURE.md §10.2)
const SHA256 = /^[0-9a-f]{64}$/;
const A = { apps: null, bundled: null, bundledError: '', listBusy: false, busy: false, file: null, run: null, ticker: null, stepsKey: '' };

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ---------- installed apps ---------- */

function appsMessage(text, tone, retry) {
  $('apps-list').replaceChildren(h('p', { class: 'empty', dataset: tone ? { tone } : {}, text },
    retry && [' ', h('button', { class: 'btn quiet', type: 'button', onclick: loadApps, text: 'Try again' })]));
}

function appControlsBlocked() {
  return A.busy || A.listBusy || S.reserved || S.paired === false || studioRole === 'guest'
    || S.status && !S.statusError && S.status.power === 'off';
}

async function loadBundledApps() {
  $('panel-bundled').hidden = !supports({ route: '/api/apps/bundled' });
  A.bundledError = '';
  if ($('panel-bundled').hidden) { A.bundled = null; return; }
  try { A.bundled = await call('GET', '/api/apps/bundled'); }
  catch (err) { A.bundled = null; A.bundledError = 'Could not read included apps: ' + err.message + '. Refresh the app list to try again.'; }
  renderBundledApps();
}

function renderBundledApps() {
  const host = $('bundled-apps');
  if (S.paired === false) { host.replaceChildren(h('p', { class: 'hint', text: 'Connect your TV first to install its included apps.' })); return; }
  if (!A.bundled) { host.replaceChildren(h('p', { class: 'hint', text: A.bundledError || 'Reading included apps…' })); return; }
  const rows = A.bundled.map(app => {
    const row = h('li', { class: 'app bundled-app' });
    const install = h('button', { class: app.installed ? 'btn' : 'btn primary', type: 'button',
      dataset: { bundledId: app.id, bundledAvailable: String(app.available) },
      'aria-label': (app.installed ? 'Repair ' : 'Install ') + app.title }, icon(app.installed ? 'refresh' : 'download'),
      h('span', { text: app.installed ? 'Repair' : 'Install on TV' }));
    install.addEventListener('click', () => installBundledApp(app, install));
    const actions = h('div', { class: 'row bundled-actions' }, install);
    if (app.installed) {
      const remove = h('button', { class: 'btn quiet', type: 'button', 'aria-label': 'Uninstall ' + app.title }, icon('trash'), 'Uninstall');
      remove.addEventListener('click', () => askRemove(row, app, app.title, remove));
      actions.append(remove);
    }
    row.append(appIcon(app), h('div', { class: 'app-meta' },
      h('div', { class: 'row' }, h('strong', { text: app.title }), h('span', { class: 'badge', text: app.installed ? 'Installed' : 'Not installed' })),
      h('p', { class: 'hint', text: app.description }), h('span', { text: app.id + (app.version ? ' · Version ' + app.version : '') }),
      !app.available && h('p', { class: 'hint', text: 'The bundled package is missing from this server. Update this project installation to enable Install/Repair.' })), actions);
    return row;
  });
  host.replaceChildren(rows.length ? h('ul', { class: 'app-list' }, rows) : h('p', { class: 'hint', text: 'This server reports no included TV apps.' }));
  syncApps();
}

async function installBundledApp(app, button) {
  if (appControlsBlocked() || !app.available) return;
  const restoreFocus = document.activeElement === button;
  A.busy = true;
  button.dataset.state = 'loading';
  button.setAttribute('aria-busy', 'true');
  result($('bundled-result'), 'Preparing the included package, installing it on the TV, and checking the installation. Keep this page open.');
  syncApps();
  try {
    const reply = await call('POST', '/api/apps/bundled/' + encodeURIComponent(app.id), { json: {} });
    if (reply.id !== app.id || reply.installed !== true) throw new Error('The server did not confirm the installed app');
    app.installed = true;
    result($('bundled-result'), reply.message, 'ok');
  } catch (err) {
    result($('bundled-result'), 'Installation was not confirmed: ' + err.message + '. Make sure the TV is on, then try Install/Repair again.', 'error');
  } finally {
    A.busy = false;
    await loadApps();
    if (restoreFocus && document.activeElement === document.body && S.view === 'apps') {
      [...$('bundled-apps').querySelectorAll('button')].find(node => node.dataset.bundledId === app.id)?.focus();
    }
  }
}

async function loadApps() {
  if (studioRole === 'guest') return;
  if (!supports({ group: 'Apps' })) return;
  if (S.paired === false) { renderBundledApps(); return appsMessage('Connect your TV first. Your apps appear here after that.'); }
  if (S.status && !S.statusError && S.status.power === 'off') { renderBundledApps(); syncApps(); return appsMessage('The TV is in standby. Turn it on to see its apps.'); }
  if (A.listBusy) return;
  A.listBusy = true;
  syncApps();
  $('apps-refresh').dataset.state = 'loading';
  if (!A.apps) appsMessage('Reading apps from the TV…');
  try {
    await loadBundledApps();
    const reply = await call('GET', '/api/apps');
    A.apps = Array.isArray(reply) ? reply : (reply && reply.apps) || [];
    renderApps();
  } catch (err) {
    A.apps = null;
    appsMessage('Could not read the app list: ' + err.message, 'error', true);
  } finally {
    A.listBusy = false;
    delete $('apps-refresh').dataset.state;
    syncApps();
  }
}

function renderApps() {
  const list = A.apps.filter(app => app.removable !== false && !A.bundled?.some(included => included.id === app.id));
  if (!list.length) return appsMessage('No added apps yet. Anything you install here shows up in this list.');
  $('apps-list').replaceChildren(h('ul', { class: 'app-list' }, list.map(appRow)));
  syncApps();
}

function syncApps() {
  const blocked = appControlsBlocked();
  for (const btn of document.querySelectorAll('#apps-list button, #bundled-apps button')) btn.disabled = blocked || btn.dataset.bundledAvailable === 'false';
  $('apps-refresh').disabled = blocked;
  syncAppForms();
}

// Only same-origin icons can load (CSP img-src 'self'); the TV's own file paths never can, so those get a letter tile.
function appIcon(app) {
  const tone = 1 + ([...app.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5);
  const ico = h('span', { class: 'ico', dataset: { tone: String(tone) }, 'aria-hidden': 'true' });
  const letter = ((app.title || app.id).trim().charAt(0) || '?').toUpperCase();
  const src = typeof app.icon === 'string' && (app.icon.startsWith('/api/') || app.icon.startsWith(location.origin + '/')) ? app.icon : '';
  if (src) {
    const img = h('img', { src, alt: '' });
    img.addEventListener('error', () => ico.replaceChildren(letter));
    ico.append(img);
  } else {
    ico.append(letter);
  }
  return ico;
}

function appRow(app) {
  const name = app.title || app.id;
  const row = h('li', { class: 'app' });
  const actions = h('button', { class: 'btn danger', type: 'button', 'aria-label': 'Uninstall ' + name }, icon('trash'), h('span', { text: 'Uninstall' }));
  actions.addEventListener('click', () => askRemove(row, app, name, actions));
  row.append(appIcon(app),
    h('div', { class: 'app-meta', title: app.id }, h('strong', { text: name }),
      h('span', { text: app.version ? 'Version ' + app.version : 'Added app' })),
    actions);
  return row;
}

// Removing an app cannot be undone, so the one-tap button asks once, in place, before anything is sent.
function askRemove(row, app, name, trigger) {
  trigger.hidden = true;
  const keep = h('button', { class: 'btn', type: 'button', text: 'Keep it' });
  const go = h('button', { class: 'btn danger-fill', type: 'button', text: 'Remove' });
  const ask = h('div', { class: 'app-confirm' }, h('p', { text: `Remove ${name} from the TV?` }), keep, go);
  keep.addEventListener('click', () => { ask.remove(); trigger.hidden = false; });
  go.addEventListener('click', () => removeApp(row, app, name, ask, go));
  row.append(ask);
  go.focus();
}

async function removeApp(row, app, name, ask, go) {
  if (appControlsBlocked()) return;
  A.busy = true;
  syncApps();
  go.dataset.state = 'loading';
  for (const btn of ask.querySelectorAll('button')) btn.disabled = true;
  try {
    await call('DELETE', '/api/apps/' + encodeURIComponent(app.id));
    say(`${name} was removed.`);
    await loadApps();
  } catch (err) {
    delete go.dataset.state;
    for (const btn of ask.querySelectorAll('button')) btn.disabled = false;
    row.querySelector('.app-error')?.remove();
    row.append(h('p', { class: 'app-error', text: `Could not remove ${name}: ${err.message}` }));
  } finally {
    A.busy = false;
    syncApps();
  }
}

/* ---------- pushing a new app ---------- */

function pickApp(file) {
  if (!file) return;
  const drop = $('app-drop');
  A.file = null;
  delete drop.dataset.ready;
  $('app-drop-main').textContent = file.name;
  if (!/\.ipk$/i.test(file.name)) {
    $('app-drop-sub').textContent = 'That is not an app file. Choose a file that ends in .ipk.';
  } else if (!file.size) {
    $('app-drop-sub').textContent = 'That file is empty. Choose another one.';
  } else {
    A.file = file;
    drop.dataset.ready = 'true';
    $('app-drop-sub').textContent = `${bytes(file.size)} · ready to install · choose another file to replace it`;
  }
  syncAppForms();
}

function syncAppForms() {
  $('app-upload').disabled = !A.file || appControlsBlocked();
  $('app-url-install').disabled = !$('app-url').value.trim() || appControlsBlocked();
}

function urlBody() {
  const msg = $('app-url-msg');
  const url = $('app-url').value.trim();
  const sha = $('app-sha').value.trim().toLowerCase().replace(/^sha256:/, '');
  if (!/^https?:\/\/\S+$/i.test(url)) return result(msg, 'Paste a full link that starts with http:// or https://', 'error');
  if (url.length > 500) return result(msg, 'That link is too long (500 characters at most).', 'error');
  if (sha && !SHA256.test(sha)) return result(msg, 'A SHA-256 checksum is exactly 64 letters and digits (0-9, a-f). Leave it empty to skip the check.', 'error');
  msg.hidden = true;
  return sha ? { url, sha256: sha } : { url };
}

function uploadIpk(file, onSent) {
  return new Promise((resolve) => {
    const started = performance.now();
    const path = '/api/apps?' + new URLSearchParams({ name: file.name });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    if (S.token) xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onSent(e.loaded / e.total); };
    const done = (status, data) => {
      addLog({ method: 'POST', path, status, ms: Math.round(performance.now() - started),
        shown: `<${file.name}: ${bytes(file.size)} of file bytes>`, data, file: file.name });
      if (status === 401) unauthorized((data && data.error) || 'token rejected');
      resolve({ status, data });
    };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = { error: `Unexpected ${xhr.getResponseHeader('Content-Type') || 'empty'} response` }; }
      done(xhr.status, data);
    };
    xhr.onerror = () => done(0, { error: 'The server is not reachable' });
    xhr.send(file);
  });
}

function stepMark(state) {
  const mk = h('span', { class: 'mk' });
  if (state === 'active') mk.append(h('span', { class: 'spinner' }));
  else if (state === 'done') {
    const svg = document.createElementNS(SVG, 'svg');
    const path = document.createElementNS(SVG, 'path');
    svg.setAttribute('class', 'check-draw');
    svg.setAttribute('viewBox', '0 0 24 24');
    path.setAttribute('d', 'm5 12.5 4.5 4.5L19 7.5');
    svg.append(path);
    mk.append(svg);
  } else if (state === 'failed') mk.append(icon('x'));
  return mk;
}

// The route answers once, when the install is over, so there is no honest percentage for the TV's part.
// What is real: the upload fraction (file path only), the elapsed time, and the 90 s ceiling the TV side enforces.
function renderProgress() {
  const run = A.run;
  const failed = run.outcome === 'error';
  const uploading = run.phase === 'upload';
  const steps = [];
  if (run.kind === 'file') steps.push(['Sending the file to this server', uploading ? (failed ? 'failed' : 'active') : 'done']);
  steps.push(['The TV downloads, checks and installs it', uploading ? 'pending' : failed ? 'failed' : run.outcome === 'ok' ? 'done' : 'active']);
  const key = steps.map((s) => s[1]).join();
  if (A.stepsKey !== key) {
    A.stepsKey = key;
    $('app-prog-steps').replaceChildren(...steps.map(([text, state]) => h('li', { dataset: { phase: state } }, stepMark(state), h('span', { text }))));
  }
  const elapsed = run.tvStart ? (performance.now() - run.tvStart) / 1000 : 0;
  $('app-progress').dataset.outcome = run.outcome || '';
  $('app-prog-ico').replaceChildren(icon(run.outcome === 'ok' ? 'check' : failed ? 'alert' : 'package'));
  $('app-prog-title').textContent = run.outcome === 'ok' ? `${run.name} is installed` : failed ? `Could not install ${run.name}` : `Installing ${run.name}`;
  $('app-prog-sub').textContent = run.outcome ? '' : uploading ? `Sending… ${Math.round(run.sent * 100)}%. Keep this page open.`
    : 'The TV is working on it. Keep this page open; this usually takes under a minute.';
  $('app-prog-budget').hidden = uploading || !!run.outcome;
  $('app-prog-bar').value = Math.min(elapsed, INSTALL_BUDGET_S);
  $('app-prog-elapsed').textContent = mmss(elapsed);
}

async function runInstall(name, kind, send) {
  if (appControlsBlocked()) return;
  A.busy = true;
  syncApps();
  syncAppForms();
  const run = { name, kind, phase: kind === 'file' ? 'upload' : 'tv', sent: 0, tvStart: kind === 'file' ? 0 : performance.now(), outcome: null };
  A.run = run;
  A.stepsKey = '';
  $('app-forms').hidden = true;
  $('app-progress').hidden = false;
  $('app-result').hidden = true;
  $('app-done').hidden = true;
  renderProgress();
  A.ticker = setInterval(renderProgress, 250);
  try {
    const reply = await send((fraction) => {
      run.sent = fraction;
      if (fraction >= 1 && run.phase === 'upload') { run.phase = 'tv'; run.tvStart = performance.now(); }
    });
    run.outcome = 'ok';
    result($('app-result'), (reply && reply.message) || 'Look for it on the TV’s Home screen.', 'ok');
    loadApps();
  } catch (err) {
    run.outcome = 'error';
    result($('app-result'), `${sentence(err.message)} Check the file or link, make sure the TV is on, then try again.`, 'error');
  }
  clearInterval(A.ticker);
  renderProgress();
  A.busy = false;
  $('app-done').textContent = run.outcome === 'ok' ? 'Add another app' : 'Try again';
  $('app-done').hidden = false;
  $('app-done').focus();
  syncApps();
}

function resetInstall() {
  $('app-progress').hidden = true;
  $('app-forms').hidden = false;
  if (A.run && A.run.outcome === 'ok') {
    A.file = null;
    $('app-file').value = '';
    $('app-url').value = '';
    $('app-sha').value = '';
    delete $('app-drop').dataset.ready;
    $('app-drop-main').textContent = 'Choose an app file';
    $('app-drop-sub').textContent = 'Tap here, or drop an .ipk file onto this box';
  }
  A.run = null;
  syncAppForms();
}

function sendFile(event) {
  event.preventDefault();
  if (!A.file || A.busy) return;
  const file = A.file;
  runInstall(file.name, 'file', async (onSent) => {
    const { status, data } = await uploadIpk(file, onSent);
    if (status >= 200 && status < 300) return data;
    throw new ApiError(status, (data && data.error) || `HTTP ${status}`);
  });
}

function sendUrl(event) {
  event.preventDefault();
  const json = urlBody();
  if (!json || A.busy) return;
  runInstall(json.url.split('/').pop().split('?')[0] || 'the app', 'url', () => call('POST', '/api/apps', { json }));
}

/* ---------- login setting ---------- */

function chosenAuth() {
  const picked = document.querySelector('input[name="auth-mode"]:checked');
  return picked ? picked.value : null;
}

function renderAuth() {
  const mode = S.authMode;
  for (const radio of document.querySelectorAll('input[name="auth-mode"]')) {
    radio.checked = radio.value === mode;
    radio.disabled = !mode;
  }
  $('auth-apply').disabled = !mode || chosenAuth() === mode;
  $('auth-hint').textContent = mode === 'disabled' ? 'Login is off' : mode === 'token' ? 'Token required' : '';
  $('auth-banner').hidden = mode !== 'disabled' || S.bannerDismissed;
}

async function loadAuth() {
  if (studioRole === 'guest') return;
  if (!supports({ route: '/api/config/auth' })) return;
  try {
    S.authMode = (await call('GET', '/api/config/auth')).mode;
    $('auth-msg').hidden = true;
  } catch (err) {
    S.authMode = null;
    if (err.status !== 401) result($('auth-msg'), 'Could not read the login setting: ' + err.message, 'error');
  }
  renderAuth();
}

async function saveAuth(mode, btn) {
  btn.dataset.state = 'loading';
  try {
    const reply = await call('PATCH', '/api/config/auth', { json: { mode, confirm: true } });
    S.authMode = reply.mode || mode;
    S.bannerDismissed = false;
    result($('auth-msg'), mode === 'disabled'
      ? 'Login is off. Anyone on this network can use this page.'
      : 'Login is on. Phones and computers will ask for the token.', 'ok');
    renderAuth();
    return true;
  } catch (err) {
    result($('auth-msg'), 'Could not change the login setting: ' + err.message, 'error');
    renderAuth();
    return false;
  } finally {
    delete btn.dataset.state;
  }
}

function openAuthConfirm() {
  $('auth-confirm-check').checked = false;
  $('auth-confirm-go').disabled = true;
  $('auth-confirm-msg').hidden = true;
  $('auth-confirm').showModal();
}

async function confirmAuthOff(event) {
  event.preventDefault();
  if (!$('auth-confirm-check').checked) return;
  if (await saveAuth('disabled', $('auth-confirm-go'))) {
    $('auth-confirm').close();
  } else {
    result($('auth-confirm-msg'), $('auth-msg').textContent, 'error');
  }
}

/* ---------- wiring ---------- */

function wireExtras() {
  const drop = $('app-drop');
  $('app-loopback-hint').hidden = !/^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);  // the TV fetches an uploaded file from this very address
  $('app-file').addEventListener('change', (e) => pickApp(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); if (!A.busy) drop.dataset.over = 'true'; });
  drop.addEventListener('dragleave', () => { delete drop.dataset.over; });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    delete drop.dataset.over;
    if (!A.busy) pickApp(e.dataTransfer.files[0]);
  });
  $('app-file-form').addEventListener('submit', sendFile);
  $('app-url-form').addEventListener('submit', sendUrl);
  $('app-url').addEventListener('input', syncAppForms);
  $('app-done').addEventListener('click', resetInstall);
  $('apps-refresh').addEventListener('click', loadApps);

  for (const radio of document.querySelectorAll('input[name="auth-mode"]')) {
    radio.addEventListener('change', () => { $('auth-apply').disabled = chosenAuth() === S.authMode; });
  }
  $('auth-apply').addEventListener('click', (e) => {
    if (chosenAuth() === 'disabled') openAuthConfirm(); else saveAuth('token', e.currentTarget);
  });
  $('auth-confirm-check').addEventListener('change', (e) => { $('auth-confirm-go').disabled = !e.target.checked; });
  $('auth-confirm-form').addEventListener('submit', confirmAuthOff);
  $('auth-confirm-cancel').addEventListener('click', () => $('auth-confirm').close());
  $('auth-confirm').addEventListener('close', renderAuth);  // any way out other than confirming puts the choice back
  $('auth-banner-dismiss').addEventListener('click', () => { S.bannerDismissed = true; renderAuth(); });
  wireZoom();

  syncAppForms();
}

/* ---------- installable app ---------- */

const INSTALL_DISMISSED = 'webos-foundry-install-dismissed';
let installPrompt = null;

// Only the static shell is cached (sw.js); registration failure (no HTTPS, blocked) is not worth telling anyone.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Chrome/Edge/Android only. Where this never fires (Safari, installed already) the banner simply never shows.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  try { if (localStorage.getItem(INSTALL_DISMISSED)) return; } catch { /* storage blocked: offer it anyway */ }
  installPrompt = event;
  $('install-banner').hidden = false;
});

function hideInstall() {
  installPrompt = null;
  $('install-banner').hidden = true;
}

$('install-go').addEventListener('click', async () => {
  const offer = installPrompt;
  hideInstall();
  if (offer) { offer.prompt(); await offer.userChoice; }
});
$('install-dismiss').addEventListener('click', () => {
  hideInstall();
  try { localStorage.setItem(INSTALL_DISMISSED, '1'); } catch { /* storage blocked: it may come back next visit */ }
});
window.addEventListener('appinstalled', hideInstall);
