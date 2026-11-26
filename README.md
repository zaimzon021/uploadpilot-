# UploadPilot v0.3.0 (cloud sync across PCs + low-load)

Windows desktop app (Electron) that uploads videos to many YouTube channels on its own, through **YouTube Studio**. Each channel runs in its own real, isolated Chromium profile (its own data folder, cookies and storage), behind its own SOCKS5 proxy. There is **no fingerprint spoofing**.

You link a channel once (sign in by hand, pick a style, pick a folder). After that, autopilot scans the folder, plans 2 uploads per day inside the upload window, has Gemini watch each video and write the title, description and tags, then uploads in up to 3 lanes running side by side. If a channel needs you (login expired, verification, captcha), that channel pauses and the other channels keep going.

**New in 0.3:** sign in once and every PC shares the same channels, plans and queue (Firestore), with leases so a video is never uploaded twice and a browser profile is open on only one PC. Logins move between PCs as an encrypted Playwright storageState. Optional Google Drive backup lets another PC take over a job if its PC dies. Gemini gets a small 360p copy. Without signing in ("Use offline") the app works exactly like 0.2.

---

## Cloud setup (once)

The installer ships the built-in project **uploadpilot-2c754** (`config/cloud.default.json`: Firebase web config + Google OAuth Desktop client ID). Everything can be overridden in **Settings → Cloud**.

### 1. Firestore rules (required: the database is in production mode = deny all)
Open <https://console.firebase.google.com/project/uploadpilot-2c754/firestore/rules>, replace everything with the contents of [`firestore.rules`](firestore.rules), press **Publish**. (CLI alternative: `npx firebase-tools deploy --only firestore:rules --project uploadpilot-2c754`.)
Already done in the console: Email/Password sign-in enabled, Firestore `(default)` in eur3.

### 2. Google Drive OAuth client secret
The Desktop client ID is built in; its **client secret is never in the repo**. Give it to the app one of three ways (first wins):
1. **Settings → Cloud → OAuth client secret** (sealed with Electron safeStorage / Windows DPAPI, stored in `secrets.json`, never in the settings table);
2. env `UPLOADPILOT_OAUTH_CLIENT_SECRET`;
3. CI: add the repository secret **`OAUTH_CLIENT_SECRET`** (GitHub → Settings → Secrets and variables → Actions). The workflow writes `config/cloud.secret.json` into the installer; without the secret the step is skipped. Google treats Desktop-app secrets as not confidential, but anyone with the installer can read a baked-in one; option 1 avoids that.

The consent screen is in **Testing**: only listed test users (zaimiftikhar0786@gmail.com, zaimbreakthrough2@gmail.com) can connect, and Google expires test-mode refresh tokens after **7 days**. Then you reconnect, or publish the consent screen to remove that limit. **Connect Google Drive** opens the system browser with an account chooser (`prompt=select_account`): pick the account whose Drive should hold backups (e.g. the 5 TB one). It can be a different account from the UploadPilot sign-in.

### 3. On every PC
1. Sign in (or **Create account** on the first PC) with the same email/password.
2. Settings → Cloud: set **the same sync passphrase** on every PC (min 8 chars; a second PC is checked against the first). It encrypts profile logins and proxy passwords. If you lose it, those can't be read; you'd sign the profiles in again.
3. Give each PC a name (shown as "running on …").
4. Connect Google Drive (needed for login sync and backups).

### Using your own Firebase project instead
Create a project → enable **Authentication › Email/Password** → create **Firestore** → publish `firestore.rules` → **Project settings › Your apps › Web app** → paste its `firebaseConfig` in Settings → Cloud (or save `{ "firebase": {...}, "google": {"clientId": "...", "clientSecret": "..."} }` as `<data>/cloud-config.json`). For Drive: Google Cloud console → enable **Google Drive API** → OAuth consent screen (External, Testing, add test users, scope `drive.file`) → Credentials → **OAuth client ID › Desktop app**.

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
src/cloud/index.js      CloudService: config layering, sign-in, starts sync/leases/backup, job + profile hooks
src/cloud/sync.js       SQLite <-> Firestore two-way sync (dirty triggers, field diffs, batched writes, onSnapshot)
src/cloud/leases.js     job / profile leases (transaction claim, 30 s renew, ~2 min expiry by server time)
src/cloud/profileState.js  login sync: storageState({indexedDB:true}) -> AES-256-GCM -> Drive; import before navigation
src/cloud/drive.js      Drive v3: folders, chunked resumable upload with speed cap, pause/abort/resume, download, back-off
src/cloud/googleAuth.js OAuth Desktop loopback + PKCE (scope drive.file), refresh token in safeStorage
src/cloud/backup.js     optional video backup (idle hours only, never during a YouTube upload, speed cap)
src/cloud/store/        Firestore adapter (modular SDK) + in-memory stand-in used by tests
src/ai/lowres.js        360p low-bitrate copy for Gemini (ffmpeg-static, idle priority, one at a time)
src/util/logRotate.js   log / run-folder / events-table / cache rotation
config/cloud.default.json  built-in cloud config (no secrets)
firestore.rules         security rules (paste into the console)
test/                   unit tests, e2e tests, mock YouTube Studio, mock Gemini, SOCKS5 server helper
```

### Profiles and proxies
* A profile is a row in `profiles` plus a folder under `<data>/profiles/profile-0001/`. Profiles get numbers in order.
* Proxies are SOCKS5 lines in the form `host:port:user:pass` (`socks5://user:pass@host:port` also works). Chromium can't do SOCKS5 auth, so each open profile gets its own **local bridge**: an unauthenticated SOCKS5 server on `127.0.0.1:<random port>` that forwards every CONNECT through the upstream proxy with user/pass (npm `socks`). Hostnames are passed through as they are, so DNS is resolved at the proxy's exit. WebRTC is limited to proxied UDP.
* **Health check before every open**: the app tunnels through the upstream proxy and fetches the exit IP (`proxyCheckUrl`, default ipify). If the proxy is dead, the profile **does not open** (no IP leak), the proxy is marked `bad`, and the channel retries later.
* Launch modes: `persistent` (default; Playwright `launchPersistentContext`, headed, plus `--remote-debugging-port` so the API can return a CDP endpoint) or `cdp` (Chrome is spawned as a normal process and Playwright attaches with `connectOverCDP`; this is closer to a hand-started browser). `--enable-automation` is removed. Autopilot windows open **minimized** (through CDP `Browser.setWindowBounds`). Background throttling is turned off so minimized windows keep working. All input goes through CDP, so the app never uses the real mouse.
* Browser binary, in this order: `browser.executablePath` (if the file exists) → the **built-in Chromium** shipped with the installer (`resources/browsers/chromium-*/chrome-win*/chrome.exe`; in a dev checkout `./browsers`, filled by `npm run browsers:install`) → installed Google Chrome → Playwright's default download folder.

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

### Cloud sync (0.3)
* **Workspace = your Firebase uid.** Everything lives under `users/{uid}/…`: `channels`, `profiles` (number, name, proxy host/port/user + **encrypted** password, login snapshot version/hash/Drive file id), `videos` (`status` queued/writing/uploading/done/failed/skipped, `detail` = local status, title/description/tags/hashtags, scheduled time, YouTube URL, `driveFileId`, origin PC), `plans/{channel}` (next 10 slots), `activity` (important events only), `pcs`, `leases`, `meta/sync` (passphrase verifier). The rules allow only the owner, require `updatedAt = server time` and check lease rules.
* **Local SQLite stays the cache and offline queue.** Triggers mark edited rows dirty; every 2 s the dirty rows are diffed against the last synced copy and only changed fields are written, merged, in batches. Remote changes arrive through `onSnapshot` listeners (no polling) and are applied field by field. A field this PC changed but hasn't pushed yet wins. Nothing echoes back.
* **Files stay where they are.** A channel's folder belongs to one PC. Other PCs see its videos as cloud copies (`cloud:<id>`). Planning and Gemini run only on the PC that has the file, and so does the YouTube upload. Another PC **takes over** a job only when (a) the owner's job lease expired mid-upload (the PC died) or (b) the video is overdue by `takeoverGraceMin` (default 120 min), **and** a Drive backup exists. It downloads the backup into `<data>/cache`, uploads it, and deletes the cache file afterwards. The owner then moves its file to `Done/`.
* **Leases** (`users/{uid}/leases/{video_<id>|profile_<id>}` = `{pcId, pcName, renewedAt: serverTimestamp, ttlSec: 120, expiresAt, released}`): claimed in a transaction before an upload and before any profile opens; renewed every 30 s; released when done. Others skip a held job/profile ("running on PC-x"). After ~2 min without renewal another PC may take over. Expiry is checked against **server time** by the rules (`request.time > renewedAt + ttl`), so a PC with a wrong clock can't steal a live lease. If a PC that lost its lease comes back, its next renewal is refused and its upload stops.
* **Profile logins** move as Playwright `storageState({indexedDB:true})`: cookies + localStorage + IndexedDB, **not** a raw folder copy (Windows DPAPI makes copied cookies useless). On close (and every 3 min for hand-used windows) the state is hashed. Only if it changed is it encrypted (AES-256-GCM, scrypt key from the passphrase) and uploaded to Drive `UploadPilot/profiles/profile-<id>.state`, with `stateVersion`++. A PC with an older or missing version downloads and imports it (`context.setStorageState`) **before the first navigation**.
* **Drive backup** (optional, off by default): `UploadPilot/channels/<channel>/<file>`. Resumable 8 MB chunks, speed cap (user KB/s, else 30% of the speed measured on the first chunk), only inside the idle-hours window (default 01:00–07:00, may wrap midnight), and never while this PC uploads to YouTube: the chunk in flight is aborted and resumed later from the server offset. Back-off on 403 `userRateLimitExceeded`/429/5xx; daily-limit errors pause it for the day; a local counter stops at 700 GB/day (Drive's limit is ~750 GB). By default the backup is deleted once the video is published (`backup.deleteAfterUpload`).
* **Quota (Spark: 50k reads / 20k writes a day):** no heartbeats except lease renewals (2 writes/min per running upload). Video progress rides on the lease renewal. Diffed and batched writes. Activity is batched every 15 s, important kinds only, max 1500/day. Videos are listened to with two narrow queries (unfinished + changed in the last 36 h). Above `writeBudget` (18k) activity/plan docs pause. Settings → Cloud shows today's reads and writes. A rough guide: 100 channels × 2 uploads/day ≈ 3–5k writes/day. Each app start re-reads the active docs (no persistent Firestore cache in Node).
* **Offline:** if Firestore can't be reached, this PC still uploads **its own** files without a lease (logged) and syncs later. It never takes over another PC's file without the cloud.

### Load rules (0.3)
Max open browsers = lanes (manual windows count too). The browser closes right after each channel. Optional **block images/video in Studio** (`browser.blockMedia`, off by default; Studio's upload preview, thumbnails and `ytimg` are always allowed). chokidar uses native events (polling only in tests). Log rotation: 14 days of logs and run folders, a log over 20 MB rolls, events table capped at 20k rows. **Pause when I'm using the PC:** no new uploads, AI or backup start while the mouse/keyboard was used in the last N minutes (Electron `powerMonitor.getSystemIdleTime`); running uploads finish. **Gemini low-bandwidth:** a 360p, ~300 kbps copy (bundled ffmpeg-static at idle priority, one at a time), deleted afterwards; the original is sent if ffmpeg is missing.

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
npm run test:emulator       # Firestore + Auth emulators with the real rules (needs firebase-tools + Java 21)
```
The Windows installer ships its own Chromium (Playwright's build matching playwright-core), so no Chrome install is needed. For a dev checkout run `npm run browsers:install` once.

Building: `npm run build` builds `dist/UploadPilot Setup 0.3.0.exe` (NSIS, x64, per-user, lets you pick the install folder, desktop shortcut). Run it on Windows (or x64 Linux). `npm run build:win-dir` makes `dist/win-unpacked/UploadPilot.exe` without NSIS.

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
| POST | `/proxies` | `{text:"line\nline", replace?:bool, sync?:bool}` (`sync`: Settings textarea semantics, `••••` lines keep their saved password) | `{added, parsed, errors[]}` (+`updated, removed, total` for sync) |
| POST | `/proxies/:id/check` | | health check result |
| POST | `/proxies/check-all` | `{text?}` (synced first when given) | `[{id,label,ok,ip?,error?}]` |
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
| POST | `/settings/gemini/test` | `{keys?: "text"}` (saved first when given) | `{keys:[{key:'…abcd', ok, error?}], models[], model, modelOk, suggested, flashModels[]}` — each key tested on its own |
| GET | `/scheduler` | | lanes, live runs |
| POST | `/autopilot/pause` \| `/autopilot/resume` | | `{paused}` |
| GET | `/cloud/status` | | state (unconfigured/signed_out/offline/connecting/online), user, PC, passphrase/Drive/backup/sync/quota/leases |
| POST | `/cloud/signin` | `{email, password, create?}` | status |
| POST | `/cloud/signout` \| `/cloud/offline` \| `/cloud/reconnect` | | status |
| POST | `/cloud/passphrase` | `{passphrase, force?}` | `{set}` (409 if it differs from the other PCs' one) |
| POST | `/cloud/drive/connect` \| `/cloud/drive/disconnect` | | `{url}` (opens the system browser) |
| POST | `/cloud/backup/run` | | runs one backup step now |

Example: `curl -s -XPOST localhost:53300/api/v1/profiles/3/open` returns `data.ws`, which you pass to `chromium.connectOverCDP(ws)` in your own tools.

---

## Settings (defaults)
videosPerDay 2 · uploadWindow 09:00–23:00 · lanes 3 · delayRangeMin 1–7 · geminiModel `gemini-3.5-flash-lite` (use "Test keys / list models" to confirm the exact name your key offers) · upload.stepTimeoutMs 60 000 · upload.channelHardLimitMs 1 200 000 · upload.maxRetries 3 · typing per char 35–160 ms for the first 350 chars, then quick chunks · browser.windowMode minimized · apiPort 53300.

Cloud: `cloud.backup` {enabled false, speedCapKBps 0 (=30% of measured), idleHours 01:00–07:00, chunkMB 8, deleteAfterUpload true} · takeoverGraceMin 120 · leaseTtlSec 120 / leaseRenewSec 30 · writeBudget 18000 · pauseWhenActive {false, 5 min} · geminiLowRes {true, 360p, 300 kbps} · browser.blockMedia false · logRetentionDays 14.

## Known gaps / risks
See TESTING.md → "Needs live verification".
