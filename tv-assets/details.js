'use strict';
// Read-only TV details (run by dispatch.sh `details`): one JSON object on stdout.
// Each field is null when its service does not answer or returns an unexpected shape.
const {spawnSync} = require('child_process');

const PQ = 'luna://com.webos.service.pqcontroller/';
const EPL = 'luna://com.webos.service.oledepl/';
const MICOM = 'luna://com.webos.service.micomservice/';
const PW = 'luna://com.webos.service.tvpower/power/';
const VO = 'luna://com.webos.service.videooutput/';
const ST = 'luna://com.webos.service.settings/';
const UCM = 'luna://com.webos.service.usercontextmanager/';

function luna(uri, payload) {
  const r = spawnSync('luna-send', ['-n', '1', '-w', '2000', uri, JSON.stringify(payload)],
    {encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'pipe']});
  if (r.error || r.status !== 0) throw new Error('no answer');
  const reply = JSON.parse(r.stdout);
  if (reply.returnValue !== true) throw new Error('refused');
  return reply;
}
const int = (v) => (Number.isInteger(v) ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
function read(fn) {
  try {
    const value = fn();
    return value === undefined ? null : value;
  } catch (e) {
    return null;
  }
}
function allSet(object) {
  return Object.values(object).every((v) => v !== null) ? object : null;
}

function signal() {
  const video = luna(VO + 'getStatus', {}).video;
  const main = Array.isArray(video) && video.find((v) => v && v.sink === 'MAIN' && v.connected === true);
  if (!main) return null;
  const info = main.videoInfo || {};
  const vrr = info.hdmiVrrInfo || {};
  return {
    app_id: str(main.appId),
    width: int(main.width),
    height: int(main.height),
    fps: typeof main.frameRate === 'number' ? main.frameRate : null,
    hdr: str(info.hdrType),
    pixel_encoding: str(info.pixelEncoding),
    timing: str(info.timingMode),
    content_type: str(info.aviContentType),
    game_mode: typeof info.isGameMode === 'boolean' ? info.isGameMode : null,
    allm: info.allmEnabled === 1 || info.allmEnabled === true,
    vrr: vrr.vrrEnabled === true,
  };
}

function usageToday() {
  const d = new Date();
  const fromDate = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const list = luna(UCM + 'getRank', {fromDate, eventType: 'app', limit: 10, orderBy: 'duration'}).appList;
  if (!Array.isArray(list)) return null;
  return list.filter((a) => str(a.appId) && int(a.totalDuration) !== null)
    .map((a) => ({app_id: a.appId, seconds: int(a.totalDuration), launches: int(a.totalLaunchCount)}));
}

function powerHistory() {
  const r = luna(MICOM + 'listPowerOnOffHistoryWithUTT', {startIndex: 0, nCount: 10});
  if (!Array.isArray(r.reasonArray)) return null;
  const hours = Array.isArray(r.uttArray) ? r.uttArray : [];
  return r.reasonArray.map((reason, i) => ({reason: String(reason), panel_hours: int(hours[i])}));
}

const out = {
  lux: read(() => int(luna(PQ + 'getInfo', {key: 'eyeQLux'}).eyeQLux)),
  panel_hours: read(() => int(luna(EPL + 'getOledPanelUTT', {}).oledPanelUTT)),
  // Whole degrees from tempMSB; LG does not document the LSB scaling, so it is not used.
  panel_temperature_c: read(() => int(luna(EPL + 'getPanelTemperature', {}).tempMSB)),
  pixel_refresher: read(() => {
    const r = luna(EPL + 'getPixelRefresherInfoList', {});
    return allSet({
      full_runs: int(r.jbCount), full_last_panel_hours: int(r.jbLastTime),
      standby_runs: int(r.offrsCount), standby_last_panel_hours: int(r.offrsLastTime),
    });
  }),
  power_on_reason: read(() => str(luna(PW + 'getPowerOnReason', {}).reason)),
  power_history: read(powerHistory),
  signal: read(signal),
  sleep_timer: read(() => str(luna(ST + 'getSystemSettings', {category: 'time', keys: ['sleepTimer']}).settings.sleepTimer)),
  usage_today: read(usageToday),
};
console.log(JSON.stringify(out));
