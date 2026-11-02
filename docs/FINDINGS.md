# Findings: what a rooted webOS 10.x TV exposes

This is evidence, not marketing. It records what was probed on **one rooted LG OLED C-series
TV (webOS 10.x, SoC family `o22n3`)**, as root, over SSH, in the project that webOS Foundry was
generalised from. Nothing here was verified on other models or firmware, and anything marked
"not tested" really was not. Names such as `luna://…` are webOS's internal Luna bus service URIs.

Practical notes:

* Over non-interactive SSH, `luna-send` prints nothing unless stdin is redirected: always end
  calls with `</dev/null`.
* `timeout 6 ls-monitor -i SERVICE` lists a service's methods and ACL groups; root passes every
  group.
* Nothing persistent was changed during the survey.

## Proven capabilities

| Capability | Call / source | Notes |
| --- | --- | --- |
| On-screen toast | `com.webos.notification/createToast {"message":…}`, `closeToast {toastId}` | Seen in a capture that includes the UI layer |
| HDMI screenshot | `com.webos.service.capture/executeOneShot {"method":"VIDEO",path,format,width,height}` | Clear (non-HDCP) source only; `DISPLAY` adds LG's own system UI (toasts) but **not** a third-party overlay app's floating window — verified live on the real TV (webOS Foundry's overlay app, a separate `WebAppMgr --app-id=…` renderer, is absent from captures by either method; confirm an overlay rendered via its own CDP devtools port instead, e.g. `luna-send … applicationManager/launch` then `GET /json` on the app's `--remote-debugging-port`) |
| Capture rate (Luna) | same call, 64×36–480×270 | ≈170 ms/frame (≈6 fps), serialised; 1080p JPG ≈290 ms, 4K ≈600 ms. For 30-60 fps see "Native fast capture" below |
| Overlay windows | a web app with `"transparent": true, "defaultWindowType": "overlay"` | Drawn over HDMI; foreground app unchanged. See "Overlay app". **Tested live this session: only one `overlay`-type window can be visible at a time, system-wide, regardless of app id.** Installed a second app (`dev.webosfoundry.overlay2`, a plain id clone) and launched it while the first was already showing: the first's `WebAppMgr` renderer process was torn down and the second took over (a brief window where both processes coexist, then the loser exits — confirmed via `ps -ef`/CDP on both app ids). The reverse (launch the first again while the second is up) behaves the same: last-launched wins. **Consequence:** webOS Foundry cannot show two independent overlay *windows* at once by launching a second app instance. It does not need to: the overlay app's window is full-screen and transparent, so one card request can carry up to four `regions` (a full-width top bar, a right-hand panel, a corner toast...) drawn as separate cards in that single window — a broadcast-style dual-pane layout is one request, not two windows (ARCHITECTURE.md §3a). |
| TTS announcement | `com.webos.service.tts/speak {"text","clear":true}` | Error 8101 unless setting `option.audioGuidance` is `on`; follows TV-speaker volume |
| Ambient light | `pqcontroller/getInfo {"key":"eyeQLux"}` | Lux integer; includes the screen's own light |
| OLED care, read-only | `oledepl/getOledPanelUTT`, `getPanelTemperature`, `getPixelRefresherInfoList`, `getGlobalStressReduction` | Panel hours counter; **never call its setters** |
| Power history | `micomservice/listPowerOnOffHistoryWithUTT {"startIndex":0,"nCount":N}` | Reasons such as `ON_BY_REMOTE_KEY`, `ON_BY_WOW_ONOFF` |
| Usage statistics | `usercontextmanager/getRank`, `getHistory {"fromDate":yyyymmdd,"eventType":"app"}` | Per-HDMI-input sessions and durations; **never call `reset`** |
| BLE scanning | `bluetooth2/le/startScan {"subscribe":true}` | Raw advertisements and RSSI (not used by webOS Foundry) |
| Signal details | `videooutput/getStatus`, `eim/getAllInputStatus`, `eim/getHDMISignalInfo` | Resolution, refresh, VRR/ALLM/HDR, cable presence |
| Sleep timer | settings category `time`, key `sleepTimer` | Read proven; write uses the same API as the AI settings |
| Custom TFLite on CPU | the TV's `libtensorflow-lite.so` C API via an `LD_PRELOAD` harness, or `/usr/bin/airunner` | LG's person detector ran in ≈330 ms/frame (not used by webOS Foundry) |

Other facts the project relies on:

* **Temperature.** `/proc/thermalinfo/soc_temperature` is an integer that LG's `fancontroller`
  compares to its die-temperature thresholds without scaling; `/proc/lg/pm/temperature` matched.
  There is no external calibration or LG-published unit specification: it is a SoC reading, not
  room or panel temperature. The panel temperature from `oledepl` is a whole-degree value whose
  scaling is inferred, not calibrated.
* **Power state.** `com.webos.service.tvpower/power/getPowerState`: `Active`/`Screen Saver` are on,
  `Active Standby` is off; any other string is treated as unknown rather than guessed.
* **Foreground app.** `com.webos.applicationManager/getForegroundAppInfo`; HDMI inputs are
  `com.webos.app.hdmi1`…`hdmi4`. The Luma home replacement (`com.ecklf.luma`) is detected by the
  mounted Home manifest's executable.
* **Remote keys.** `com.webos.service.networkinput/sendSpecialKey` (`HOME`, `BACK`, `UP`, `DOWN`,
  `LEFT`, `RIGHT`, `ENTER`); input switching via `applicationManager/launch` of `com.webos.app.hdmiN`;
  volume/mute via `com.webos.service.audio/master/*` with read-back.
* **AI picture/sound settings.** `com.webos.service.settings/getSystemSettingDesc` and
  `getSystemSettings`/`setSystemSettings` per category (`aiPicture`, `picture`, `sound`), scoped by a
  context (input, picture mode) the TV reports.
* **Wake from standby.** Wake-on-LAN works and needs SSH/network to remain reachable in normal
  standby; it cannot restore power after unplugging.

## Blocked or absent

| Item | Finding |
| --- | --- |
| Electricity | No watt or kWh source exists. A smart plug is still required. |
| NPU (≈0.4 TOPS) | Runs only LG-compiled `.lgnpu` packages (no compiler on the TV) and is shared exclusively with AI Picture. The installed TFLite delegate references vendor-compiled `lgnpu_custom_op` models; arbitrary custom-model execution is unproven. |
| Capture, Luna streaming mode | The Luna handle/streaming mode fails (`ERROR_INTERNAL`, whitelist). The native client below bypasses it. |
| CEC | Probed live (this session, `com.webos.service.eim`): CEC itself is ready (`cec/getCECState` -> `"cecReady":true`) and HDMI 1 is configured for power sync (`getCECPowerSyncStatus {"connectedInput":"HDMI_1"}` -> `{"powerSync":"sendPowerOff"}`), but no device has ever been CEC-addressed — `getDeviceInfo` shows `"lastUniqueId":-1` on every HDMI port, and `getTotalCECHistoryCount` -> 37 is TV-internal bus activity, not a paired device (`listCecHistory`'s real parameter shape was not found: both `{}` and `{"startIndex","endIndex"}` answer `EIM.101 parameters / parameter value types are wrong`). The send method (`cec/sendKeyEvent`) answers a fast, safe `{"returnValue":false,"errorText":"Fail to parse"}` for a guessed body rather than hanging, so it is not dangerous to call, but its real parameter shape is also unconfirmed and there is no connected CEC device to prove a command actually reaches anything. **Conclusion: building a CEC remote-control verb now would be unverifiable** — the plumbing exists and looks safe to probe further, but without a CEC-capable device plugged into an HDMI port there is nothing to send a command *to*, so correctness cannot be shown end to end. Revisit with a real CEC device attached. |
| Matter | A controller (`com.webos.service.matter`) exists but has no commissioned fabric. |
| Account / cloud services | ThinQ, Home Hub, voice and Chromecast built-in need an account or cloud service, or were not provisioned. |
| Audibility | TTS was not confirmed audible by ear; `audio/playSound` was accepted but not heard. |
| Microphone | A requested five-second raw wake-on-voice mic capture produced about 1 s before stalling; the remote's `voiceinput.hidraw/getDevices` returned no devices. Not a working microphone API. |

### Exposed, high-risk methods

These exist and root can call them. webOS Foundry's dispatcher has no verb that reaches them
([SAFETY.md](SAFETY.md)): `systemservice/erase/*`, `micomservice` firmware and power commands,
`oledepl` pixel-refresh setters, `usercontextmanager/reset`, `/proc/lg/*/pwm_duty`.

### Network exposure observed

The TV's Bluetooth adapter stayed discoverable and pairable, and the TV served DLNA (`:1384`),
AirPlay (`:7000`), SSAP (`:3000`/`:3001`) and LPD (`:515`) on the LAN.

## Native fast capture

The Luna screenshot tops out around 6 fps. The TV's own `/usr/lib/libvtcapture.so.1` can stream the
HDMI video plane much faster; webOS Foundry ships `vtcap`, a small C client of that library
(`tv-assets/vtcap/`), and yields RGB24 frames.

**Why a role is needed.** `vtCapture_create()` registers an LS2 name
(`com.webos.service.capture.client-<random>`), and `ls-hubd` only grants names to an executable with a
role file; without one it aborts with `LSRegisterPubPriv FAILED` ("Invalid permissions", error -1027).
Installing the client writes the binary to a directory under `/media/developer/`, plus a JSON role and
manifest in `/var/luna-service2-dev/roles.d` and `manifests.d` (the same dev-mode directories the
Homebrew Channel uses; existing files are untouched), then runs `ls-control scan-volatile-dirs`. The
role is scoped to that executable path and allows only `com.webos.service.capture.client*` and
`com.webos.rm.client.*`. With manifest version `"1"` the role was **not** applied; `"1.0.0"` worked.

**API on this firmware** (the webosbrew `tv-native-apis` `vtCaptureApi_c.h` matches):
`vtCapture_create` → `init(caller, client)` → `preprocess({dump, loc, reg=WxH, buf_cnt=3, frm})` →
`planeInfo` → `process` → poll `currentCaptureBuffInfo` (returned plane pointers, no mmap needed) →
`stop` → `postprocess` → `finalize` → `release`. A generic caller id was accepted. The plane is NV21
(full-size Y, interleaved VU), BT.709 limited range; colours matched a Luna `executeOneShot`
reference. The `reg` size is scaled by the video driver: requesting 160×90 returns a 160×90 plane
(stride 160); 320×180, 480×270, 960×540, 1920×1080 and 3840×2160 were also accepted. The library also
exports `*Ex` and histogram variants; they were not used.

**`dump` selects the tap:** 2 (default) is the video plane without UI; 3 is blended with the OSD (a
toast showed only there); 0 is scaler input (unscaled, stride 3840); 1 and 4 looked like the video
plane. The test source was 3840×2160 @ 120 Hz RGB.

**Measured** (160×90, 8 s each, a PC desktop on HDMI 1): 30.4 fps at `-f 30` (mean interval 32.9 ms,
max 54 ms); 60.1 fps at `-f 60` (16.6 ms, max 23 ms). `-f 120` still delivers 60 fps, so the driver
maximum is 60 fps. 320×180 holds 60 fps. The client used about 8-10% of one core at 160×90 (30/60 fps),
about 23% at 320×180@60, and about 70% at 960×540@30 (point-sampling reads from slow buffers); the
whole-TV figure from `/proc/stat` swung between 0 and 13% from background load alone, so the client's
own `cpu_ms` is the trustworthy number. Three clean start/stop cycles and a `kill -9` of the SSH client
left the TV on HDMI 1 with `captureservice` still answering and no leftover process. These are
measurements on one TV; they are not a promise for yours.

**Stream format** (stdout): the 4 bytes `C5F1`, `u16le width`, `u16le height`, then frames of
`width*height*3` bytes (RGB24, row-major) with no per-frame header. SIGTERM, SIGINT, SIGHUP or a closed
pipe end the loop and run `stop`/`postprocess`/`finalize`/`release`. Exit codes: 0 clean, 2 usage, 3
setup failed, 4 capture stalled. Only one capture session at a time was tested, and it was not run
concurrently with the Luna screenshot.

## Overlay app

A small web app can draw one card over whatever is on screen, including HDMI. It uses the technique
from [webos-av-overlay](https://github.com/SammySco/webos-av-overlay): `appinfo.json` sets
`"transparent": true` and `"defaultWindowType": "overlay"`, and the page calls
`PalmSystem.setInputRegion` with a 1×1 region and `PalmSystem.window.setFocus(false)`. Launch
parameters carry the card; `handlesRelaunch` updates a visible card in place. webOS Foundry's app id
is `dev.webosfoundry.overlay`, installed through `appInstallService/dev/install`.

Verified on the reference TV:

* the card renders at the requested corner over HDMI 1;
* the foreground app stays the HDMI app, so status polling is unaffected;
* the window is visible about 2.5 s after a cold launch; a relaunch updates it in about 0.4 s; hide
  closes it;
* the overlay window **does** take key focus: a remote button press while a card is up dismisses it
  and is not passed to the input underneath (pointer movement is ignored);
* relaunching an app can close the TV's own menus, so avoid pinning cards while using them.

Card schema: `{title?, body?, lines?: [...], image?: http(s) URL, kind?:
info|success|warning|alert, position?: top-left|top-right|bottom-left|bottom-right|center,
seconds?: 0-300}` (0 keeps it until hidden; default 8 s). Unknown fields, control characters and
non-http(s) images are refused, and nothing is launched while the TV is in standby.

## AI picture and sound processing

The reference pipelines route files through the TV's existing picture and sound processing; they do
not run custom models.

* **Image.** Input 8-bit PNG/JPEG, even 16:9 up to 1920×1080, encoded to static lossy H.264 (CRF 15,
  8-bit YUV 4:2:0) on the host, served on the TV's loopback, played by the Media Discovery app, and
  captured as a 3840×2160 PNG via `com.webos.service.capture/executeOneShot` with `method=VIDEO`
  after the TV confirms a matching VDEC source and a 3840×2160 hardware output. AI Picture Pro was
  inactive in a movie source's Personalized mode, so the pipeline temporarily selects Normal and
  restores both afterwards. It is not a colour-managed, HDR or archival processor. The TV's 4K scaling
  is part of the playback pipeline; no standalone, documented upscaling API was found.
* **Audio.** Stereo 48 kHz 16-bit PCM WAV, 1-30 s, played through PulseAudio's `pcm_output` using the
  disconnected HDMI 4 context and captured from digital `hw:LGSIC,3` (`SoundEngineCapture`), not a
  room microphone. The driver advertises S16_LE but returns 32-bit samples, so capture is S32_LE; the
  output is peak-normalised to 80% of full scale. Volume/profile changes can clear mute, so mute is
  applied last and verified. Low capture volume reduces precision.
* **Measured with generated media:** repeated standard image frames differed by a mean absolute RGB
  difference of 0.00229/255; AI Picture Pro versus standard 0.65581/255; the additional Super
  Resolution effect 0.36262/255; AI Sound / Clear Voice versus standard changed the relative
  3 kHz-to-200 Hz balance by 6.97 / 15.84 dB. These show changed pixels/PCM beyond baseline variation,
  not perceptual improvement or execution of a particular neural sub-algorithm.
* Both pipelines reserve the TV (one at a time under a TV-side `flock`); outputs are published only
  after state restoration is verified. Failed or interrupted runs keep a private TV workspace with a
  `restore.json` for recovery. Network loss and power failure during a run were not tested.
