'use strict';
// Google Drive API v3 client (plain fetch). Only what UploadPilot needs:
//  * folders: UploadPilot/channels/<channel>/ and UploadPilot/profiles/ (drive.file scope)
//  * resumable uploads in chunks with a speed cap, pause between chunks, abort mid-chunk and resume
//    from the server's offset (session URL can be kept across restarts)
//  * downloads (streamed to disk, resumable with Range)
//  * back-off on 403 userRateLimitExceeded / rateLimitExceeded / 429 / 5xx; stop for the day on the
//    ~750 GB/day upload limit (dailyCapBytes, default 700 GB, also counted locally)
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { Throttle, throttledChunks } = require('./throttle');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RATE_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'backendError', 'internalError']);
const QUOTA_REASONS = new Set(['dailyLimitExceeded', 'uploadLimitExceeded', 'storageQuotaExceeded', 'quotaExceeded', 'teamDriveFileLimitExceeded']);
const MiB = 1024 * 1024;

class DriveError extends Error { constructor(msg, status, reason) { super(msg); this.status = status; this.reason = reason; this.code = QUOTA_REASONS.has(reason) ? 'DRIVE_QUOTA' : 'DRIVE_ERROR'; } }

class DriveClient {
  /**
   * @param {object} o
   * @param {() => Promise<string>} o.getToken
   * @param {string} [o.baseUrl='https://www.googleapis.com']
   * @param {Function} [o.fetchImpl]
   * @param {(ms:number)=>Promise} [o.sleep]
   * @param {number} [o.dailyCapBytes]
   * @param {{get:()=>object, set:(o:object)=>void}} [o.usageStore]  persists today's uploaded bytes
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ getToken, baseUrl = 'https://www.googleapis.com', fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), dailyCapBytes = 700e9, usageStore = null, log = () => {}, maxRetries = 7, rootName = 'UploadPilot' }) {
    Object.assign(this, { getToken, fetch: fetchImpl, sleep, dailyCapBytes, usageStore, log, maxRetries, rootName });
    this.base = baseUrl.replace(/\/$/, '');
    this.folderCache = new Map();
    this.blockedUntil = 0;
    this.backoffs = 0;
    this._usage = usageStore ? usageStore.get() || {} : {};
  }

  _today() { return new Date().toISOString().slice(0, 10); }
  bytesToday() { return this._usage.day === this._today() ? this._usage.bytes || 0 : 0; }
  _addBytes(n) { const d = this._today(); if (this._usage.day !== d) this._usage = { day: d, bytes: 0 }; this._usage.bytes += n; if (this.usageStore) this.usageStore.set(this._usage); }

  async _auth(h = {}) { return { Authorization: `Bearer ${await this.getToken()}`, ...h }; }

  async _errorFrom(res) {
    let j = null; const t = await res.text().catch(() => '');
    try { j = JSON.parse(t); } catch (_) { /* not json */ }
    const reason = j && j.error && (j.error.errors && j.error.errors[0] && j.error.errors[0].reason || j.error.status) || '';
    return new DriveError(`Drive HTTP ${res.status}${reason ? ' ' + reason : ''}: ${(j && j.error && j.error.message) || t.slice(0, 200)}`, res.status, reason);
  }
  _retryable(e) { return e.status === 429 || e.status >= 500 || (e.status === 403 && RATE_REASONS.has(e.reason)) || (!e.status && e.name !== 'AbortError' && e.code !== 'DRIVE_QUOTA'); }
  _backoffMs(n) { return Math.min(64000, 1000 * 2 ** n) + Math.floor(Math.random() * 1000); }

  /** Run one HTTP call with retries / back-off. fn() must return a fetch Response; ok statuses pass. */
  async _call(fn, { ok = s => s >= 200 && s < 300, what = 'request' } = {}) {
    if (this.blockedUntil > Date.now()) throw new DriveError(`Drive daily limit reached — paused until ${new Date(this.blockedUntil).toLocaleString()}`, 403, 'dailyLimitExceeded');
    for (let n = 0; ; n++) {
      let err;
      try {
        const res = await fn();
        if (ok(res.status)) return res;
        err = await this._errorFrom(res);
      } catch (e) { err = e; }
      if (err.code === 'DRIVE_QUOTA') { this.blockedUntil = Date.now() + 6 * 3600e3; throw err; }
      if (!this._retryable(err) || n >= this.maxRetries) throw err;
      const ms = this._backoffMs(n);
      this.backoffs++;
      this.log(`Drive ${what}: ${err.message.split('\n')[0]} — retrying in ${Math.round(ms / 1000)}s`);
      await this.sleep(ms);
    }
  }

  async _json(url, opts = {}, what) { const res = await this._call(async () => this.fetch(url, { ...opts, headers: await this._auth(opts.headers) }), { what }); return res.json(); }

  _q(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  async findChild(parentId, name, { folder = false } = {}) {
    const q = `name='${this._q(name)}' and '${parentId}' in parents and trashed=false${folder ? ` and mimeType='${FOLDER_MIME}'` : ''}`;
    const j = await this._json(`${this.base}/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id,name,size,modifiedTime)', spaces: 'drive', pageSize: '10' })}`, {}, 'list');
    return (j.files || [])[0] || null;
  }

  async createFolder(name, parentId) {
    return this._json(`${this.base}/drive/v3/files?fields=id,name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }) }, 'create folder');
  }

  /** ['channels','My Channel'] -> folder id of UploadPilot/channels/My Channel (created as needed). */
  async ensureFolder(parts) {
    const all = [this.rootName, ...parts].map(p => String(p).replace(/[\\/]/g, '_').trim() || '_');
    let parent = 'root', key = '';
    for (const name of all) {
      key += '/' + name;
      let id = this.folderCache.get(key);
      if (!id) {
        const hit = await this.findChild(parent, name, { folder: true });
        id = hit ? hit.id : (await this.createFolder(name, parent)).id;
        this.folderCache.set(key, id);
      }
      parent = id;
    }
    return parent;
  }

  /** Start a resumable session; returns the session URL. fileId = overwrite an existing file. */
  async startSession({ name, parentId, size, mimeType = 'application/octet-stream', fileId = null }) {
    const url = fileId ? `${this.base}/upload/drive/v3/files/${fileId}?uploadType=resumable&fields=id,name,size,md5Checksum`
      : `${this.base}/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum`;
    const meta = fileId ? { name } : { name, parents: [parentId] };
    const res = await this._call(async () => this.fetch(url, { method: fileId ? 'PATCH' : 'POST', headers: await this._auth({ 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) }), body: JSON.stringify(meta) }), { what: 'start upload' });
    const loc = res.headers.get('location');
    if (!loc) throw new DriveError('Drive did not return an upload session URL', res.status);
    return loc;
  }

  /** Ask the server how much of a session it has. -> {offset} or {done:file} or {expired:true} */
  async queryOffset(sessionUrl, size) {
    const res = await this._call(async () => this.fetch(sessionUrl, { method: 'PUT', headers: await this._auth({ 'Content-Length': '0', 'Content-Range': `bytes */${size}` }) }), { ok: s => s === 308 || s === 200 || s === 201 || s === 404 || s === 410, what: 'resume query' });
    if (res.status === 404 || res.status === 410) return { expired: true };
    if (res.status === 200 || res.status === 201) return { done: await res.json() };
    const r = res.headers.get('range');
    return { offset: r ? +r.split('-')[1] + 1 : 0 };
  }

  /**
   * Upload a file (or Buffer) with a resumable session.
   * @param {object} o
   * @param {string|Buffer} o.source
   * @param {string} o.name
   * @param {string} [o.parentId]
   * @param {string} [o.fileId]            overwrite this file (keeps its id)
   * @param {string} [o.sessionUrl]        resume a session from an earlier run
   * @param {(url:string)=>void} [o.onSession]
   * @param {Throttle} [o.throttle]
   * @param {() => boolean|Promise<boolean>} [o.shouldPause]   checked before every chunk
   * @param {() => AbortSignal} [o.signalFor]                  abort the chunk in flight (e.g. a YouTube upload starts)
   * @param {(sent:number,total:number)=>void} [o.onProgress]
   * @param {number} [o.chunkBytes=8 MiB]  (multiple of 256 KiB)
   */
  async upload(o) {
    const isBuf = Buffer.isBuffer(o.source);
    const size = isBuf ? o.source.length : fs.statSync(o.source).size;
    if (this.bytesToday() + size > this.dailyCapBytes) throw new DriveError(`Drive daily upload budget reached (${Math.round(this.bytesToday() / 1e9)} GB today)`, 403, 'uploadLimitExceeded');
    const chunk = Math.max(256 * 1024, Math.floor((o.chunkBytes || 8 * MiB) / (256 * 1024)) * 256 * 1024);
    let session = o.sessionUrl || null, offset = 0;
    if (session) {
      const q = await this.queryOffset(session, size).catch(() => ({ expired: true }));
      if (q.done) return q.done;
      if (q.expired) session = null; else offset = q.offset;
    }
    if (!session) { session = await this.startSession({ name: o.name, parentId: o.parentId, size, mimeType: o.mimeType, fileId: o.fileId }); if (o.onSession) o.onSession(session); }
    const fh = isBuf ? null : await fs.promises.open(o.source, 'r');
    try {
      let restarts = 0;
      while (true) {
        while (o.shouldPause && await o.shouldPause()) await this.sleep(o.pausePollMs || 2000);
        const end = Math.min(size, offset + chunk);
        let part;
        if (isBuf) part = o.source.subarray(offset, end);
        else { part = Buffer.alloc(end - offset); await fh.read(part, 0, part.length, offset); }
        const signal = o.signalFor ? o.signalFor() : undefined;
        let res;
        try {
          res = await this.fetch(session, {
            method: 'PUT', signal, duplex: 'half',
            headers: await this._auth({ 'Content-Length': String(part.length), 'Content-Range': size ? `bytes ${offset}-${end - 1}/${size}` : 'bytes */0' }),
            body: part.length ? Readable.toWeb(Readable.from(throttledChunks(part, o.throttle, { signal }))) : undefined,
          });
        } catch (e) {
          // aborted (YouTube upload started) or network drop: ask the server where we are and go on
          if (e.name !== 'AbortError') { this.backoffs++; await this.sleep(this._backoffMs(Math.min(restarts++, 5))); }
          const q = await this.queryOffset(session, size);
          if (q.done) { this._addBytes(size - offset); return q.done; }
          if (q.expired) throw new DriveError('Upload session expired', 404);
          offset = q.offset; continue;
        }
        if (res.status === 200 || res.status === 201) { this._addBytes(end - offset); if (o.onProgress) o.onProgress(size, size); return res.json(); }
        if (res.status === 308) {
          const r = res.headers.get('range');
          const next = r ? +r.split('-')[1] + 1 : 0;
          this._addBytes(Math.max(0, next - offset));
          offset = next;
          if (o.onProgress) o.onProgress(offset, size);
          continue;
        }
        const err = await this._errorFrom(res);
        if (err.code === 'DRIVE_QUOTA') { this.blockedUntil = Date.now() + 6 * 3600e3; throw err; }
        if (res.status === 404 || res.status === 410) throw new DriveError('Upload session expired', res.status);
        if (!this._retryable(err) || restarts >= this.maxRetries) throw err;
        const ms = this._backoffMs(restarts++);
        this.backoffs++;
        this.log(`Drive upload: ${err.message.split('\n')[0]} — retrying in ${Math.round(ms / 1000)}s`);
        await this.sleep(ms);
        const q = await this.queryOffset(session, size);
        if (q.done) return q.done;
        if (q.expired) throw new DriveError('Upload session expired', 404);
        offset = q.offset;
      }
    } finally { if (fh) await fh.close(); }
  }

  /** Download a file to dest (written to dest.part first; resumes with Range after drops). */
  async download(fileId, dest, { throttle = null, signal } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    for (let n = 0; ; n++) {
      try {
        const res = await this._call(async () => this.fetch(`${this.base}/drive/v3/files/${fileId}?alt=media`, { signal, headers: await this._auth(have ? { Range: `bytes=${have}-` } : {}) }), { ok: s => s === 200 || s === 206, what: 'download' });
        if (res.status === 200 && have) have = 0;            // server ignored Range: start over
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        for await (const c of Readable.fromWeb(res.body)) {
          if (throttle) await throttle.take(c.length, signal);
          if (!out.write(c)) await new Promise(r => out.once('drain', r));
          have += c.length;
        }
        await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
        fs.renameSync(part, dest);
        return { path: dest, size: have };
      } catch (e) {
        if (e.name === 'AbortError' || e.status || n >= 4) throw e;
        await this.sleep(this._backoffMs(n));
      }
    }
  }

  async downloadBuffer(fileId) {
    const res = await this._call(async () => this.fetch(`${this.base}/drive/v3/files/${fileId}?alt=media`, { headers: await this._auth() }), { what: 'download' });
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(fileId) {
    await this._call(async () => this.fetch(`${this.base}/drive/v3/files/${fileId}`, { method: 'DELETE', headers: await this._auth() }), { ok: s => s === 204 || s === 200 || s === 404, what: 'delete' });
  }

  /** Small file in a folder, overwritten in place when it already exists (same id). */
  async putSmall({ parts, name, data, mimeType = 'application/octet-stream' }) {
    const parentId = await this.ensureFolder(parts);
    const existing = await this.findChild(parentId, name);
    return this.upload({ source: data, name, parentId, fileId: existing ? existing.id : null, mimeType, chunkBytes: Math.max(256 * 1024, data.length + 256 * 1024) });
  }
}

/** Speed cap for backups: user KB/s, else pct% of the measured upload speed (bytes/s), else a safe default. */
function backupRate({ speedCapKBps = 0, speedCapPct = 30, measuredBps = 0, fallbackBps = 256 * 1024 }) {
  if (speedCapKBps > 0) return speedCapKBps * 1024;
  if (measuredBps > 0) return Math.max(32 * 1024, Math.round(measuredBps * (speedCapPct || 30) / 100));
  return fallbackBps;
}

module.exports = { DriveClient, DriveError, backupRate, Throttle, FOLDER_MIME };
