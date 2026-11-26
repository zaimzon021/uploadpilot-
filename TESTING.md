# TESTING — UploadPilot v0.1.0

Environment: Linux arm64 sandbox, Node 22.23, Electron 45.5 (Node 24 inside), playwright-core 1.65 with Playwright Chromium (build 1255), Xvfb, ffmpeg, Python 3.12 + `pproxy` (an independent SOCKS5 server that supports auth).
Rules followed: **no real Google/YouTube login, no real proxies or credentials.** Everything ran against local mocks.

## Results summary (2026-11-26)

| Suite | File(s) | Tests | Pass | Fail |
|---|---|---|---|---|
| Unit: Gemini parsing, key pool, mock-HTTP pipeline, 429/403 rotation, back-off | `test/unit/gemini.test.js` | 8 | 8 | 0 |
| Unit: plan builder (+ time helpers) | `test/unit/planner.test.js` | 6 | 6 | 0 |
| Unit: folder scan, move-to-Done, chokidar watcher | `test/unit/scanner-watcher.test.js` | 3 | 3 | 0 |
| Unit: lane scheduler (lanes, delays, daily shuffle, fairness, stop) | `test/unit/laneScheduler.test.js` | 5 | 5 | 0 |
| Unit: proxy parsing, exit-IP parsing, browser args | `test/unit/proxy-parse.test.js` | 4 | 4 | 0 |
| Unit: channel runner guard rails + AI worker | `test/unit/channelRunner.test.js` | 4 | 4 | 0 |
| **Unit total** | `npm test` | **30** | **30** | **0** |
| E2E: SOCKS5 auth bridge vs pproxy (+ real Chromium both launch modes) | `test/e2e/socks-bridge.test.js` | 6 | 6 | 0 |
| E2E: upload engine vs mock Studio (flows + recovery) | `test/e2e/upload-engine.test.js` | 8 | 8 | 0 |
| E2E: upload engine timeouts / hard limit / detector | `test/e2e/upload-engine-failures.test.js` | 3 | 3 | 0 |
| E2E: full system (API + wizard + proxies + AI + lanes + uploads) | `test/e2e/autopilot.test.js` | 4 | 4 | 0 |
| E2E: local API, every endpoint (43/43) + security | `test/e2e/api.test.js` | 7 | 7 | 0 |
| **E2E total** | `xvfb-run -a npm run test:e2e` | **28** | **28** | **0** |
| Electron smoke (window, renderer, API, 4 screenshots) | `npm run smoke:electron` (+`--seed`) | 8 steps | 8 | 0 |

**Grand total: 58 automated tests + 8 smoke steps, all passing.** The e2e files were run one at a time (`xvfb-run -a node --test test/e2e/<file>`) because the sandbox caps each command at 2 minutes. Each one passes alone. On a normal machine, `npm run test:e2e` runs them all in a row.

## What each suite proves

### Plan builder
2/day spread across the two halves of the window, in order, whole minutes · late in the day (22:40) starts tomorrow · mid-day only uses the remaining segment and never schedules in the past · already-used slots count toward the daily quota and the free segment is used · 200 random seeds × perDay 3: always inside the window, minimum gap kept · custom window, validation errors.

### Folder scan / watcher
mp4/MOV/mkv/webm only, `.txt` / hidden / empty / `Done/` ignored, natural sort, thumbnail matching ignores case (jpg/jpeg/png) · move-to-Done never overwrites · watcher: a file written in chunks is reported **only after it stops growing**, exactly once with its full size; thumbnail reported; files in `Done/` and non-video files ignored.

### Lane scheduler
7 channels / 3 lanes: each channel runs exactly once, a channel is never in two lanes, a lane is strictly sequential (checked by an assertion inside the runner), max 3 running at a time · delay sampling stays in 1–7 min and uses the whole range · the real loop waits at least the minimum delay between runs in a lane · daily shuffle: same order within a day, new order the next day, new channels added at the end · least-recently-run first, busy and cooling channels skipped · `stop()` wakes sleeping lanes in under 500 ms · a runner exception doesn't kill the lane.

### Gemini (mock HTTP server imitating Files API + generateContent)
Parsing: plain JSON, ```json fences, response envelope, prose around JSON, arrays · normalisation: title ≤ 100 chars (cut at a word boundary), quotes stripped, `<>` stripped, tags de-duplicated / `#` removed / total ≤ 450 chars, hashtags normalised · errors: empty, invalid JSON, no candidates, SAFETY block · footer + hashtag merge · full pipeline over real HTTP: resumable start headers, the **whole file streamed** (byte count checked), polled until ACTIVE, generate, file deleted · 429 key → next key; 403 key → disabled for 6 h · all keys rate-limited → sleeps for the cooldown, then succeeds · bad JSON → retries with another key, then fails with a clear error.

### SOCKS5 bridge (independent server: pproxy with `user:pass`, `--auth 0`)
Upstream really refuses connections without auth · bridge: plain SOCKS5 client → bridge → authenticated upstream → target (HTTP 200), 20 tunnels in parallel · wrong upstream password → tunnel refused and the failure counted · health check returns the exit IP; wrong password / dead port → `ok:false` · **real Chromium** (persistent profile, and the `cdp` spawn+attach mode) loads a page through the bridge, and the CDP ws endpoint is returned.

### Upload engine vs mock YouTube Studio
The mock (`test/mock-studio/`) copies Studio's DOM: `ytcp-button#create-icon`, creation menu `tp-yt-paper-item#text-item-0`, `ytcp-uploads-dialog` with a hidden `input[type=file][name=Filedata]`, contenteditable `#title-textarea #textbox` / `#description-textarea #textbox` (title pre-filled with the filename, as Studio does), `tp-yt-paper-radio-button[name=VIDEO_MADE_FOR_KIDS_*]` (Next is blocked until one is chosen), `#toggle-button` Show more → `#tags-container input` with comma chips, `input#file-loader` thumbnail, stepper panes toggled with `hidden`, `#next-button/#back-button/#done-button`, visibility radios `PRIVATE/UNLISTED/PUBLIC`, `ytcp-video-upload-progress .progress-label` ("Uploading 45%…" → "Upload complete … Processing" → "Checks complete"), `ytcp-video-info .video-url-fadeable a`, and the `ytcp-video-share-dialog` done dialog with `#share-url`. It records exactly what was submitted.
* Happy path (~12 s at test speed): title with emoji, multi-line description, tags, not-for-kids, PUBLIC, thumbnail and filename all checked in the submission; publish happened **after** the transfer finished; returned URL = submitted video; every state was visited; a "done" screenshot was saved.
* Made-for-kids + UNLISTED honoured.
* Error dialog on Next → detected, screenshotted, dismissed, flow continues (1 error shown).
* Random error dialogs (p = 0.5 on every Next) → still completes.
* Upload dialog disappears mid-flow → engine notices and re-opens + re-uploads → completes.
* Verification page → `NEEDS_USER/verification` in < 20 s with a screenshot, no retry loop. Expired session → `NEEDS_USER/google_login`. Daily limit dialog → `UPLOAD_LIMIT`.
* Upload stuck at 37% → step timeout → 3 attempts (dismiss → reload → new tab), 3 failure screenshots, **never published**, gave up in ~32 s with a 4 s step timeout.
* Studio stuck on a spinner → the hard limit stops the run on time (8 s budget, stopped in 8–20 s).
* Detector recognises dashboard, upload dialog, Google login, verification, blank, no-channel, new-device.

Bugs these tests found and fixed: emoji were split into broken surrogate halves when typed char by char · `ytcp-*` host elements are 0×0 boxes, so visibility now also looks at child elements · the hard-limit result was overwritten · CDP launch mode used the wrong attach URL.

### Full system (`autopilot.test.js`)
Two pproxy SOCKS5 servers with different credentials; mock Studio also acts as the Google sign-in page. The app was driven **only through the HTTP API**:
1. `PUT /settings {proxyPool}` → 2 added, 1 bad line reported.
2. Two link-wizard runs: a new profile with its own auto-assigned proxy, a proxy health check (exit IP checked), a browser opened at sign-in. The "user" signs in inside that window. Login detected from Google session cookies → Studio read → `{name:'Mock Channel', channelId, handle:'@mockchannel'}` → style → folder → channel active, link browser closed, videos planned with no Start button.
3. Videos made due through `PATCH /videos/:id {scheduled_at}`: Gemini (2 keys, both used) wrote metadata → 2 lanes uploaded all 4 videos in ~28 s, using lanes 0 and 1. Each submission had the AI title, AI description + footer + merged hashtags, tags, PUBLIC, not-for-kids, and the session cookie from the persistent profile. Thumbnails were sent for the 2 clips that had them. URLs stored, files moved to `Done/`, `run.log` per run, dashboard and activity feed correct.
4. Watcher: a new file dropped in → added and planned.
5. Verification set for **channel A only** → A becomes `needs_you` ("Google verification / captcha") with its video kept `ready`, while **B keeps uploading**. Then resume A → A uploads.

### Local API
All 42 routes + the SSE stream hit for real (43 counted): settings (keys masked, validation 400), proxies (no passwords returned), profile open returns a working CDP ws (verified with `connectOverCDP`), a dead proxy blocks opening (502), channel stop/resume/patch/scan, video edit/approve/skip/retry (101-char title → 400), linked profile protected from delete (409), wizard guards (409) and cancel cleanup, SSE live delivery, pause/resume. Security: bound to 127.0.0.1 · foreign Host header → 403 · browser Origin without token → 403 · optional `apiToken` → 401 without the header.

### Electron
`npm run smoke:electron` (xvfb): window + renderer load, dashboard numbers come from the local API, screenshots of Dashboard / Channels / Settings / Link wizard in `smoke/`, API health from main, `better-sqlite3` loads inside Electron. `electron-builder --win --x64 --dir` built `dist/win-unpacked/UploadPilot.exe` with the N-API `win32-x64.node` prebuild unpacked. The final **NSIS step (`makensis`) fails on this arm64 sandbox** (EPIPE from the bundled makensis). It is expected to work on Windows or x64 Linux; the build config itself is done. `dist/` was deleted afterwards to save space.

## Needs live verification (not testable here)
1. **YouTube Studio selectors** (`src/upload/selectors.js`). They are written from what Studio's DOM is known to look like, not checked against the live site. Check in priority order: `#create-icon` and the "Upload videos" item; the file input inside `ytcp-uploads-file-picker`; `#title-textarea #textbox` / `#description-textarea #textbox`; the kids radio `name`s; `#toggle-button` and the tags input; `input#file-loader` (custom thumbnails need a phone-verified channel; the engine logs and skips if it's missing); pane element names (`ytcp-uploads-details/-video-elements/-checks/-review`) used for step detection; `.progress-label` texts (English UI is assumed: **the detector's text patterns are English**, so set the Studio/Google account language to English); done-dialog element names and `#share-url`; and the SCHEDULE widget (written without testing).
2. **Google sign-in in an automated profile**: Google may show "This browser or app may not be secure" for Playwright-launched Chrome. Mitigations in place: real Chrome, no `--enable-automation`, `AutomationControlled` turned off, and the `cdp` launch mode (a normal Chrome process with an attached debugger), which is the one to try first if sign-in is blocked.
3. **Login detection** uses the `SID / __Secure-1PSID / __Secure-3PSID / SAPISID` cookies, then reads the channel from Studio (`#entity-name`, `/channel/UC…` in the URL). The handle comes from the page or a fetch of `youtube.com/channel/<id>`, best effort.
4. **Focus / minimized windows on Windows**: windows are minimized through CDP right after launch. A window may still flash or take focus for a moment while it is created. Screenshots of minimized windows may come out blank or time out (they're capped at 10 s and never block the run).
5. **Duplicate drafts**: if the dialog is lost after the file was chosen, the retry uploads again, which can leave an extra draft in Studio.
6. **Gemini model name**: the default `gemini-3.5-flash-lite` came from the brief and wasn't checked. Use Settings → "Test keys / list models". Large videos stream to the Files API but count against Gemini quotas.
7. **Real proxies**: only tested against local SOCKS5 servers. `proxyCheckUrl` is ipify over HTTPS through the tunnel.
8. **Windows packaging**: run `npm run build` on a Windows machine. Chrome must be installed (playwright-core ships no browser).
9. **Upload window across midnight** (e.g. 20:00–02:00) isn't supported; the end time must come after the start time.
