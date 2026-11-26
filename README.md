# UploadPilot (v0.1.0, first working version)

Windows desktop app (Electron) that uploads videos to many YouTube channels on its own, through **YouTube Studio**. Each channel runs in its own real, isolated Chromium profile (its own data folder, cookies and storage), behind its own SOCKS5 proxy. There is **no fingerprint spoofing**.

You link a channel once (sign in by hand, pick a style, pick a folder). After that, autopilot scans the folder, plans 2 uploads per day inside the upload window, has Gemini watch each video and write the title, description and tags, then uploads in up to 3 lanes running side by side. If a channel needs you (login expired, verification, captcha), that channel pauses and the other channels keep going.

---

## Architecture

```
electron/main.js        Electron main: starts the core, the UI window and a tray icon (closing the window hides it; autopilot keeps running)
electron/preload.js     exposes config (API URL + session token), folder picker, open-path to the renderer
renderer/               UI in plain HTML/CSS/JS (Dashboard, Channels, Channel detail, Settings, Link wizard). Talks ONLY to the local API.
src/core/app.js         UploadPilotApp: wires everything; also runs headless (src/headless.js)
src/core/db.js          SQLite (better-sqlite3, N-API prebuilds; falls back to node:sqlite)
src/core/settings.js    settings with defaults (JSON in the settings table)
src/core/events.js      activity feed + daily app log + SSE fan-out
src/profiles/           profile engine: create/open/close/delete, proxy per profile, Chromium launch
src/proxy/              proxy parsing, local SOCKS5 auth bridge, health check (exit IP)
src/autopilot/          folder scanner, chokidar watcher, plan builder, lane scheduler
src/ai/gemini.js        Gemini REST: Files API upload, poll ACTIVE, generateContent (JSON schema), delete; key rotation + 429 back-off
src/upload/selectors.js EVERY Studio/Google selector and text pattern (fix them here after live checks)
src/upload/detect.js    screen-state detector (one page.evaluate)
src/upload/engine.js    upload state machine + recovery ladder + timeouts
src/upload/humanize.js  human-like mouse and typing, sent through CDP only
src/upload/channelRunner.js  one lane run: open profile, upload due videos, close (hard limit of 20 min)
src/wizard/linkWizard.js     3-step link flow
src/api/server.js       local JSON API on 127.0.0.1:53300
test/                   unit tests, e2e tests, mock YouTube Studio, mock Gemini, SOCKS5 server helper
```

### Profiles and proxies
* A profile is a row in `profiles` plus a folder under `<data>/profiles/profile-0001/`. Profiles get numbers in order.
* Proxies are SOCKS5 lines in the form `host:port:user:pass` (`socks5://user:pass@host:port` also works). Chromium can't do SOCKS5 auth, so each open profile gets its own **local bridge**: an unauthenticated SOCKS5 server on `127.0.0.1:<random port>` that forwards every CONNECT through the upstream proxy with user/pass (npm `socks`). Hostnames are passed through as they are, so DNS is resolved at the proxy's exit. WebRTC is limited to proxied UDP.
* **Health check before every open**: the app tunnels through the upstream proxy and fetches the exit IP (`proxyCheckUrl`, default ipify). If the proxy is dead, the profile **does not open** (no IP leak), the proxy is marked `bad`, and the channel retries later.
* Launch modes: `persistent` (default; Playwright `launchPersistentContext`, headed, plus `--remote-debugging-port` so the API can return a CDP endpoint) or `cdp` (Chrome is spawned as a normal process and Playwright attaches with `connectOverCDP`; this is closer to a hand-started browser). `--enable-automation` is removed. Autopilot windows open **minimized** (through CDP `Browser.setWindowBounds`). Background throttling is turned off so minimized windows keep working. All input goes through CDP, so the app never uses the real mouse.
* Browser binary: `browser.executablePath`, or else auto-detect (installed Google Chrome on Windows, then a Playwright Chromium in `%LOCALAPPDATA%\ms-playwright`). playwright-core does **not** bundle a browser.

### Autopilot
1. **Scan**: reads the top level of the channel folder for `mp4/mov/mkv/webm`. A thumbnail is a `.jpg/.jpeg/.png` with the same base name (case doesn't matter). The `Done/` subfolder, hidden files and empty files are skipped. Files are sorted naturally (`clip2` comes before `clip10`).
2. **Plan**: N videos per channel per day (default 2; can be set per channel). The upload window (default 09:00–23:00, local time) is split into N segments, and each video gets a random whole-minute time inside its segment, with a 10% margin on each side. Today only uses segments that haven't passed yet (now + 10 min). Uploads already done or planned count toward the day.
3. **Watch**: chokidar (`awaitWriteFinish`) adds new files once they stop growing, then re-plans. Thumbnails added later attach to their video.
4. **AI**: every 20 s, videos planned for today (`aiLookaheadDays` = 0) are sent to Gemini: upload, wait for ACTIVE, `generateContent` with `responseSchema`, then delete the file. The answer is validated: title ≤ 100 chars, tags de-duplicated and kept under 450 chars, hashtags normalised. In auto mode the video becomes `ready`; in approval mode it becomes `awaiting_approval`. Keys rotate round-robin. A 429 cools that key down (Retry-After or exponential) and the next key is tried. A 401/403 disables the key for 6 h. Bad JSON retries with another key. After 3 failed rounds the video shows "AI failed", and typing a title by hand makes it uploadable. Hand-edited fields are never overwritten by AI.
5. **Description sent to YouTube** = AI description + the channel's fixed footer + AI hashtags and fixed hashtags (de-duplicated).
6. **Lanes**: 3 by default. Each lane runs strictly one thing at a time: pick a channel, open its profile, upload all of that channel's due videos, close, wait a random 1–7 min, then the next channel. A channel is never in two lanes at once. Channel order is shuffled once per day; among due channels, the one that ran longest ago goes first. Nothing starts outside the window.

### Upload engine (state machine)
States detected from the URL, visible elements and visible text: `google_login, verification, new_device, no_channel, upload_limit, error_dialog, dashboard, upload_dialog, details, elements, checks, visibility, done, loading, blank, unknown`.

Flow: studio → Create → Upload videos (or the dashboard upload icon) → `setInputFiles` on the hidden file input (no OS dialog) → title (read back and re-inserted if it doesn't match) → description → thumbnail → made-for-kids → Show more → tags → Next ×3 → visibility (PUBLIC default; UNLISTED/PRIVATE; SCHEDULE best effort) → **wait until the file transfer is complete** → Publish/Save → done dialog → read the `youtu.be` URL. A video is marked `done` only after that, and then its file and thumbnail move to `<folder>/Done/`.

Failure handling:
* Every state has a step timeout (default 60 s without progress). If the progress label stops moving for a full step timeout, the upload counts as stuck.
* On failure: screenshot, then the recovery ladder. Attempt 1: dismiss dialogs and continue from the current screen. Attempt 2: reload. Attempt 3: new tab. Up to 3 attempts per video.
* Error dialogs are screenshotted, dismissed, and the flow continues.
* login / verification / captcha / new-device / no channel → **channel paused as "Needs you"**, the video stays queued, and other channels keep running. Daily upload limit → channel pauses until 09:00 tomorrow.
* **Hard limit of 20 min per channel run**: a timer closes the browser, which makes every pending Playwright call fail, so a run can never hang. Leftover videos are marked failed and the lane moves on.
* Logs: `<data>/logs/app-YYYY-MM-DD.log`, plus one folder per run, `<data>/logs/runs/<date>/run-00042-ch7/`, holding `run.log` and numbered screenshots.

### Data location
Electron: `%APPDATA%\UploadPilot` (`app.getPath('userData')`), or `UPLOADPILOT_DATA` if set. Headless: `~/.uploadpilot`.

---

## Run

```bash
npm install                 # Node 20+ (22 tested). better-sqlite3 v13 ships N-API prebuilds (win32-x64 included); no compiler needed
npm start                   # Electron app (dev)
npm run headless            # core + API without UI
npm test                    # unit tests
xvfb-run -a npm run test:e2e   # e2e (Linux needs a display or xvfb; uses a Playwright Chromium)
npm run smoke:electron      # Electron smoke test under xvfb (add --seed for demo data screenshots)
npm run build               # Windows NSIS installer (electron-builder) → dist/
```
On Windows you need Google Chrome installed, or run `npx playwright install chromium` once, or set Settings → Browser path.

Building: `npm run build` builds `dist/UploadPilot Setup 0.1.0.exe` (NSIS, x64, per-user, lets you pick the install folder, desktop shortcut). Run it on Windows (or x64 Linux). `npm run build:win-dir` makes `dist/win-unpacked/UploadPilot.exe` without NSIS.

---

## Local API reference

Base: `http://127.0.0.1:53300/api/v1` (loopback only). Every response looks like `{"code":0,"message":"success","data":…}`; errors look like `{"code":<http>,"message":"…"}`.
Security: the Host header must be loopback (blocks DNS rebinding). A request carrying a browser `Origin` header needs the UI session token. If `apiToken` is set in Settings, **every** request needs the header `X-UploadPilot-Token: <token>`.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/health` | | `{ok, version, db}` |
| GET | `/dashboard` | | totals: channels, publishedToday, plannedToday, inQueue, needsYou(+detail), nextUpload, autopilot, ai, proxies |
| GET | `/events?limit=50` | | recent activity |
| GET | `/events/stream` | `?token=` for browsers | SSE live activity |
| GET | `/profiles` | | profiles with proxy, open, channel |
| POST | `/profiles` | `{name?, proxy?:"h:p:u:pw", proxyId?, autoProxy?:true}` | profile |
| GET | `/profiles/:id` | | profile |
| POST | `/profiles/:id/open` | `{url?, skipProxyCheck?, headless?}` | `{ws, debugPort, http, exitIp, proxyBridge}`; `ws` is the CDP browser endpoint |
| POST | `/profiles/:id/close` | | `{closed}` |
| DELETE | `/profiles/:id` | `?force=1` if linked to an active channel | `{deleted}` (removes data folder) |
| POST | `/profiles/:id/proxy` | `{proxy:"h:p:u:pw"}` or `{proxyId}` | profile |
| POST | `/profiles/:id/proxy/check` | | `{ok, ip, ms, error?}` |
| GET | `/proxies` | | pool (no passwords) |
| POST | `/proxies` | `{text:"line\nline", replace?:bool}` | `{added, parsed, errors[]}` |
| POST | `/proxies/:id/check` | | health check result |
| POST | `/proxies/check-all` | | results |
| DELETE | `/proxies/:id` | | `{deleted}` |
| GET | `/channels` | | channels with stats, live state |
| GET | `/channels/:id` | | channel |
| GET | `/channels/:id/status` | | `{status, reason, live, next_upload, done_today, planned_today, queue, failed, …}` |
| POST | `/channels/:id/stop` | | status |
| POST | `/channels/:id/resume` | | status (also clears Needs you / limit pause) |
| PATCH | `/channels/:id` | `{name?, folder?, style?:{niche,language,madeForKids,footer,hashtags,mode,visibility,perDay}}` | channel |
| DELETE | `/channels/:id` | `?deleteProfile=1` | `{deleted}` |
| POST | `/channels/:id/scan` | | `{added, total}` |
| POST | `/channels/:id/open-profile` | | opens the profile at Studio for manual use |
| GET | `/channels/:id/videos` | | plan list |
| GET | `/channels/:id/runs` | | last 50 runs with log folder |
| PATCH | `/videos/:id` | `{title?, description?, tags?, hashtags?, scheduled_at?}` | video |
| POST | `/videos/:id/approve` \| `/retry` \| `/skip` | | video |
| POST | `/link/start` | `{name?, proxy?, proxyId?}` | wizard session (opens the browser at Google sign-in) |
| GET | `/link/:id` | | `{step, status: opening/waiting_login/reading_channel/connected/no_channel/…, channel:{name,channelId,handle}, profileNumber, proxy}` |
| POST | `/link/:id/style` | `{niche, language, madeForKids, footer, hashtags, mode:"auto"|"approval", visibility?}` | session |
| POST | `/link/:id/folder` | `{folder}` | channel active, autopilot starts |
| DELETE | `/link/:id` | | cancels and removes the half-made profile |
| GET / PUT | `/settings` | PUT accepts any setting, plus `proxyPool` (text, replaces the pool except proxies in use) and `geminiKeys` (text or array) | settings (keys masked) |
| POST | `/settings/gemini/test` | | `{models[]}` |
| GET | `/scheduler` | | lanes, live runs |
| POST | `/autopilot/pause` \| `/autopilot/resume` | | `{paused}` |

Example: `curl -s -XPOST localhost:53300/api/v1/profiles/3/open` returns `data.ws`, which you pass to `chromium.connectOverCDP(ws)` in your own tools.

---

## Settings (defaults)
videosPerDay 2 · uploadWindow 09:00–23:00 · lanes 3 · delayRangeMin 1–7 · geminiModel `gemini-3.5-flash-lite` (use "Test keys / list models" to confirm the exact name your key offers) · upload.stepTimeoutMs 60 000 · upload.channelHardLimitMs 1 200 000 · upload.maxRetries 3 · typing per char 35–160 ms for the first 350 chars, then quick chunks · browser.windowMode minimized · apiPort 53300.

## Known gaps / risks
See TESTING.md → "Needs live verification".
