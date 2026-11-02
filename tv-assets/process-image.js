'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const {spawnSync} = require('child_process');

const profiles = {
  standard: {ai_Picture: 'off', superResolution: 'off'},
  'ai-picture': {ai_Picture: 'on', superResolution: 'off'},
  'ai-picture-sr': {ai_Picture: 'on', superResolution: 'high'},
};
const [directory, profile, widthText, heightText] = process.argv.slice(2);
const width = Number(widthText), height = Number(heightText);
const app = 'com.webos.app.mediadiscovery';
const appUri = 'luna://com.webos.applicationManager/';
const settingsUri = 'luna://com.webos.service.settings/';
let interruption;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  interruption = new Error('Processing interrupted by ' + signal);
});

function luna(uri, payload) {
  const result = spawnSync('luna-send', ['-n', '1', '-w', '5000', uri, JSON.stringify(payload)],
    {encoding: 'utf8', timeout: 5500, stdio: ['ignore', 'pipe', 'pipe']});
  if (result.error || result.status !== 0) throw new Error('Local service did not answer: ' + uri);
  const reply = JSON.parse(result.stdout);
  if (reply.returnValue !== true) throw new Error(uri + ': ' + JSON.stringify(reply));
  return reply;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const foreground = () => luna(appUri + 'getForegroundAppInfo', {}).appId;
const settings = (category, keys) => luna(settingsUri + 'getSystemSettings', {category, keys});
const set = (category, values) => luna(settingsUri + 'setSystemSettings', {category, settings: values});
function ownedVideo() {
  const output = luna('luna://com.webos.service.videooutput/getStatus', {});
  return output.video.find(video => video.connected && video.connectedSource === 'VDEC' &&
    video.appId === app && video.width === width && video.height === height &&
    video.displayOutput.width === 3840 && video.displayOutput.height === 2160);
}
async function until(test, message) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (interruption) throw interruption;
    if (test()) return;
    await delay(40);
  }
  throw new Error(message);
}

async function run() {
  if (!/^\/tmp\/webos-foundry-ai\.[A-Za-z0-9]+$/.test(directory || '') ||
      !Object.prototype.hasOwnProperty.call(profiles, profile) ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 18 ||
      width > 1920 || height > 1080 || width % 2 || height % 2 || width * 9 !== height * 16) {
    throw new Error('Expected owned workspace, supported profile, and even 16:9 dimensions up to 1080p');
  }
  const originalApp = foreground();
  if (typeof originalApp !== 'string' || !originalApp || originalApp === app) {
    throw new Error('Leave Media Player before processing; its current playback cannot be restored');
  }
  const videoFile = path.join(directory, 'input.mp4'), size = fs.statSync(videoFile).size;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url !== '/input.mp4' || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404); return response.end();
    }
    let start = 0, end = size - 1, status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (match) {
        start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      }
      if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        response.writeHead(416, {'Content-Range': 'bytes */' + size}); return response.end();
      }
      status = 206;
    }
    const headers = {'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes'};
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') return response.end();
    const stream = fs.createReadStream(videoFile, {start, end});
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let originalMode, normalState, payload, failure;
  let launched = false;
  const recovery = {originalApp};
  const recoveryPath = path.join(directory, 'restore.json');
  const saveRecovery = () => fs.writeFileSync(recoveryPath, JSON.stringify(recovery), {mode: 0o600});
  saveRecovery();
  const watchdog = setTimeout(() => { interruption = new Error('Image processing deadline exceeded'); }, 25000);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    payload = {payload: [{fullPath: 'http://127.0.0.1:' + server.address().port + '/input.mp4',
      mediaType: 'VIDEO', deviceType: 'DMR', fileName: 'input.mp4'}]};
    luna(appUri + 'launch', {id: app, params: payload});
    launched = true;
    await until(() => ownedVideo(), 'The supplied image was not hardware decoded at the expected resolution');
    const initial = settings('picture', ['pictureMode']);
    if (initial.dimension.input !== 'movie') throw new Error('Unexpected picture source; refusing mode changes');
    originalMode = initial.settings.pictureMode;
    recovery.originalMode = originalMode; saveRecovery();
    set('picture', {pictureMode: 'normal'});
    await until(() => {
      const value = settings('picture', ['pictureMode']);
      return value.dimension.input === 'movie' && value.settings.pictureMode === 'normal';
    }, 'Normal movie picture mode did not activate');
    normalState = {aiPicture: settings('aiPicture', ['ai_Picture']).settings,
      picture: settings('picture', ['superResolution']).settings};
    recovery.normalState = normalState; saveRecovery();
    const descriptor = luna(settingsUri + 'getSystemSettingDesc', {category: 'aiPicture', keys: ['ai_Picture']});
    if (profiles[profile].ai_Picture === 'on' &&
        !descriptor.results.some(value => value.key === 'ai_Picture' && value.ui.active === true)) {
      throw new Error('AI Picture Pro is unavailable in this playback context');
    }
    set('aiPicture', {ai_Picture: profiles[profile].ai_Picture});
    set('picture', {superResolution: profiles[profile].superResolution});
    if (settings('aiPicture', ['ai_Picture']).settings.ai_Picture !== profiles[profile].ai_Picture ||
        settings('picture', ['superResolution']).settings.superResolution !== profiles[profile].superResolution) {
      throw new Error('Picture processing readback mismatch');
    }
    if (interruption || !ownedVideo()) throw new Error('Source changed; refusing to capture another input');
    const capture = luna('luna://com.webos.service.capture/executeOneShot', {
      path: path.join(directory, 'captured.png'), method: 'VIDEO', format: 'PNG', width: 3840, height: 2160,
    });
    if (interruption || !ownedVideo() || capture.capturedWidth !== 3840 || capture.capturedHeight !== 2160) {
      throw new Error('Capture source changed or returned the wrong dimensions; output discarded');
    }
  } catch (error) { failure = error; }
  finally {
    clearTimeout(watchdog);
    const savedInterruption = interruption; interruption = undefined;
    const errors = [];
    try {
      if (originalMode) {
        if (!ownedVideo()) {
          luna(appUri + 'launch', {id: app, params: payload});
          await until(() => ownedVideo(), 'Cannot restore the movie picture context');
        }
        set('picture', {pictureMode: 'normal'});
        if (normalState) {
          for (const [category, values] of Object.entries(normalState)) {
            set(category, values);
            const actual = settings(category, Object.keys(values)).settings;
            if (!Object.keys(values).every(key => actual[key] === values[key])) throw new Error('Picture restoration mismatch');
          }
        }
        set('picture', {pictureMode: originalMode});
        if (settings('picture', ['pictureMode']).settings.pictureMode !== originalMode) throw new Error('Original movie mode not restored');
      }
    } catch (error) { errors.push(error.message); }
    if (launched) {
      for (const [method, data] of [['launch', {id: originalApp}], ['closeByAppId', {id: app}]]) {
        try { luna(appUri + method, data); } catch (error) { errors.push(error.message); }
      }
    }
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    try { await until(() => foreground() === originalApp, 'Original foreground app not restored'); }
    catch (error) { errors.push(error.message); }
    interruption = savedInterruption;
    if (errors.length) throw new Error('Restoration failed; keep ' + recoveryPath + ': ' + errors.join('; '));
  }
  if (failure) throw failure;
  return {profile, ...profiles[profile], source_resolution: [width, height], output_resolution: [3840, 2160],
    hardware_decoder: 'VDEC', picture_mode_during_processing: 'normal', capture_method: 'VIDEO', restored: true};
}
run().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
