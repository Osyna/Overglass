'use strict';
const fs = require('fs');
const {spawn, spawnSync} = require('child_process');
const path = require('path');

const profiles = {
  standard: {soundMode: 'standard', aiSound: 'off', clearVoice: 'off'},
  'ai-sound': {soundMode: 'aiSoundPlus', aiSound: 'on', clearVoice: 'off'},
  'clear-voice': {soundMode: 'voiceEnhance', aiSound: 'off', clearVoice: 'level3'},
};
const [directory, profile, secondsText] = process.argv.slice(2);
const seconds = Number(secondsText);
let recorder, player, interruption;

function luna(uri, payload) {
  const result = spawnSync('luna-send', ['-n', '1', '-w', '2000', uri, JSON.stringify(payload)],
    {encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'pipe']});
  if (result.error || result.status !== 0) throw new Error('Local service did not answer: ' + uri);
  const reply = JSON.parse(result.stdout);
  if (reply.returnValue !== true) throw new Error(uri + ': ' + JSON.stringify(reply));
  return reply;
}
const settingsUri = 'luna://com.webos.service.settings/';
const audioUri = 'luna://com.webos.service.audio/master/';
const appUri = 'luna://com.webos.applicationManager/';
const keys = ['soundMode', 'aiSound', 'clearVoice'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const foreground = () => luna(appUri + 'getForegroundAppInfo', {}).appId;
const sound = () => luna(settingsUri + 'getSystemSettings', {category: 'sound', keys});
const volume = () => luna(audioUri + 'getVolume', {}).volumeStatus;

async function until(test, message, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (interruption) throw interruption;
    if (test()) return;
    await delay(40);
  }
  throw new Error(message);
}

function child(command, args, env = process.env) {
  const process = spawn(command, args, {env, stdio: ['ignore', 'ignore', 'pipe']});
  let errors = '';
  process.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
  process.done = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve() : reject(new Error(command + ': ' + errors)));
  });
  process.done.catch(() => {});
  return process;
}

async function stop(process) {
  if (!process) return;
  if (process.exitCode === null) process.kill('SIGTERM');
  await process.done.catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  interruption = new Error('Processing interrupted by ' + signal);
  if (player) player.kill('SIGTERM');
  if (recorder) recorder.kill('SIGTERM');
});

async function run() {
  if (!/^\/tmp\/webos-foundry-ai\.[A-Za-z0-9]+$/.test(directory || '') ||
      !Object.prototype.hasOwnProperty.call(profiles, profile) ||
      !Number.isInteger(seconds) || seconds < 1 || seconds > 30) {
    throw new Error('Expected owned workspace, supported profile, and 1-30 capture seconds');
  }
  const devices = luna('luna://com.webos.service.eim/getAllInputStatus', {}).devices;
  const isolated = devices.find(device => device.id === 'HDMI_4');
  if (!isolated || isolated.connected || isolated.hdmiPlugIn || isolated.hdmiSignalExist) {
    throw new Error('HDMI 4 must be disconnected to avoid capturing another source');
  }
  const originalApp = foreground();
  const originalVolume = volume();
  if (typeof originalApp !== 'string' || !originalApp || originalVolume.soundOutput !== 'tv_speaker' ||
      !Number.isInteger(originalVolume.volume) || typeof originalVolume.muteStatus !== 'boolean') {
    throw new Error('Need a readable foreground app and TV-speaker output state');
  }
  let isolatedSound, failure;
  const recovery = {originalApp, originalVolume};
  const recoveryPath = path.join(directory, 'restore.json');
  fs.writeFileSync(recoveryPath, JSON.stringify(recovery), {mode: 0o600});
  const watchdog = setTimeout(() => {
    interruption = new Error('Audio processing deadline exceeded');
    if (player) player.kill('SIGTERM');
    if (recorder) recorder.kill('SIGTERM');
  }, (seconds + 20) * 1000);
  try {
    luna(appUri + 'launch', {id: 'com.webos.app.hdmi4'});
    await until(() => foreground() === 'com.webos.app.hdmi4', 'HDMI 4 did not activate');
    await until(() => (sound().dimension.audioInput || '').startsWith('hdmi4'), 'Audio source did not settle');
    isolatedSound = sound().settings;
    recovery.isolatedSound = isolatedSound;
    fs.writeFileSync(recoveryPath, JSON.stringify(recovery), {mode: 0o600});
    luna(settingsUri + 'setSystemSettings', {category: 'sound', settings: profiles[profile]});
    const actual = sound().settings;
    if (!keys.every(key => actual[key] === profiles[profile][key])) throw new Error('Sound profile readback mismatch');
    // Apply mute last: changing the volume/profile can clear it.
    // shortcut: volume 1 limits capture precision; use a calibrated pre-volume tap for production quality.
    luna(audioUri + 'setVolume', {soundOutput: 'tv_speaker', volume: 1});
    luna(audioUri + 'muteVolume', {soundOutput: 'tv_speaker', mute: true});
    const output = path.join(directory, 'captured.wav');
    // The TV's sound driver returns 32-bit samples even when S16_LE is requested.
    recorder = child('arecord', ['-q', '-D', 'hw:LGSIC,3', '-t', 'wav', '-f', 'S32_LE',
      '-r', '48000', '-c', '2', '-d', String(seconds + 2), output]);
    await until(() => {
      if (recorder.exitCode !== null) throw new Error('Sound-engine capture stopped before playback');
      return fs.existsSync(output) && fs.statSync(output).size > 44;
    }, 'Sound-engine capture did not produce PCM', 3000);
    if (volume().muteStatus !== true) throw new Error('Speaker mute was changed; refusing playback');
    player = child('aplay', ['-q', '-D', 'pulse', path.join(directory, 'input.wav')],
      {...process.env, PULSE_SINK: 'pcm_output'});
    await player.done;
    if (volume().muteStatus !== true) throw new Error('Speaker mute changed during playback');
    await recorder.done;
    const finalInput = luna('luna://com.webos.service.eim/getAllInputStatus', {}).devices.find(device => device.id === 'HDMI_4');
    if (foreground() !== 'com.webos.app.hdmi4' || !finalInput ||
        finalInput.connected || finalInput.hdmiPlugIn || finalInput.hdmiSignalExist) {
      throw new Error('Isolation source changed; captured output discarded');
    }
    if (interruption) throw interruption;
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(watchdog);
    await stop(player);
    await stop(recorder);
    const errors = [];
    const savedInterruption = interruption;
    interruption = undefined;
    const restore = action => { try { action(); } catch (error) { errors.push(error.message); } };
    if (isolatedSound) {
      try {
        if (foreground() !== 'com.webos.app.hdmi4') luna(appUri + 'launch', {id: 'com.webos.app.hdmi4'});
        await until(() => foreground() === 'com.webos.app.hdmi4' &&
          (sound().dimension.audioInput || '').startsWith('hdmi4'), 'Cannot restore HDMI 4 sound context');
        luna(settingsUri + 'setSystemSettings', {category: 'sound', settings: isolatedSound});
        const actual = sound().settings;
        if (!keys.every(key => actual[key] === isolatedSound[key])) throw new Error('Sound settings restoration mismatch');
      } catch (error) { errors.push(error.message); }
    }
    restore(() => luna(audioUri + 'setVolume', {soundOutput: 'tv_speaker', volume: originalVolume.volume}));
    restore(() => luna(audioUri + 'muteVolume', {soundOutput: 'tv_speaker', mute: originalVolume.muteStatus}));
    restore(() => luna(appUri + 'launch', {id: originalApp}));
    try {
      await until(() => foreground() === originalApp, 'Original foreground app was not restored');
      const actual = volume();
      if (actual.volume !== originalVolume.volume || actual.muteStatus !== originalVolume.muteStatus) {
        throw new Error('Original volume or mute state was not restored');
      }
    } catch (error) { errors.push(error.message); }
    interruption = savedInterruption;
    if (errors.length) throw new Error('Restoration failed; keep ' + recoveryPath + ': ' + errors.join('; '));
  }
  if (failure) throw failure;
  return {profile, device: 'hw:LGSIC,3', format: 'S32_LE', sample_rate: 48000, channels: 2,
    capture_seconds: seconds + 2, speakers_muted: true, capture_volume: 1, restored: true};
}

run().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
