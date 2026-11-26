'use strict';
// SQLite wrapper. Uses better-sqlite3; falls back to node:sqlite (built into Node 22.13+/Electron 3x+)
// if the native module cannot be loaded (e.g. ABI mismatch during development).
// Only positional "?" parameters are used so both drivers behave identically.
const fs = require('fs');
const path = require('path');

function openDriver(file) {
  try {
    const Better = require('better-sqlite3');
    const db = new Better(file);
    return { db, driver: 'better-sqlite3' };
  } catch (e) {
    const { DatabaseSync } = require('node:sqlite');
    return { db: new DatabaseSync(file), driver: 'node:sqlite', fallbackReason: e.message };
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT, password TEXT,
  label TEXT, status TEXT DEFAULT 'unknown', last_ip TEXT, last_check INTEGER, last_error TEXT,
  UNIQUE(host, port, username)
);
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER UNIQUE NOT NULL,
  name TEXT, data_dir TEXT NOT NULL, proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, last_opened INTEGER, notes TEXT
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  name TEXT, handle TEXT, yt_channel_id TEXT,
  folder TEXT, style TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'linking',
  status_reason TEXT, paused_until INTEGER,
  created_at INTEGER NOT NULL, last_run INTEGER
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  path TEXT NOT NULL, thumb TEXT, filename TEXT NOT NULL, size INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  scheduled_at INTEGER,
  ai_status TEXT NOT NULL DEFAULT 'pending', ai_error TEXT, ai_attempts INTEGER DEFAULT 0,
  title TEXT, description TEXT, tags TEXT, hashtags TEXT, edited INTEGER DEFAULT 0,
  url TEXT, attempts INTEGER DEFAULT 0, error TEXT,
  created_at INTEGER NOT NULL, uploaded_at INTEGER,
  UNIQUE(channel_id, path)
);
CREATE INDEX IF NOT EXISTS idx_videos_sched ON videos(channel_id, status, scheduled_at);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER, lane INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER,
  result TEXT, detail TEXT, log_dir TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, level TEXT NOT NULL, channel_id INTEGER, kind TEXT, message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS key_usage (key_hash TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, PRIMARY KEY(key_hash, day));
`;

class DB {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const { db, driver, fallbackReason } = openDriver(file);
    this.db = db; this.driver = driver; this.fallbackReason = fallbackReason;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this._stmts = new Map();
    this.migrate();
  }

  /** v0.3: cloud sync columns + change tracking. Safe to run on every start. */
  migrate() {
    const cols = t => new Set(this.db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name));
    const add = (t, defs) => { const have = cols(t); for (const [c, d] of defs) if (!have.has(c)) this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
    const common = [['cloud_id', 'TEXT'], ['dirty', 'INTEGER DEFAULT 1'], ['cloud_shadow', 'TEXT']];
    add('channels', [...common, ['folder_pc', 'TEXT'], ['folder_pc_name', 'TEXT']]);
    add('profiles', [...common, ['state_version', 'INTEGER DEFAULT 0'], ['state_hash', 'TEXT'], ['cloud_state_version', 'INTEGER DEFAULT 0'], ['cloud_state_hash', 'TEXT'], ['cloud_state_file', 'TEXT'], ['cloud_state_by', 'TEXT']]);
    add('videos', [...common, ['remote', 'INTEGER DEFAULT 0'], ['origin_pc', 'TEXT'], ['origin_pc_name', 'TEXT'], ['drive_file_id', 'TEXT'], ['backup_error', 'TEXT']]);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_cloud ON channels(cloud_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_cloud ON profiles(cloud_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_cloud ON videos(cloud_id);
      CREATE INDEX IF NOT EXISTS idx_videos_dirty ON videos(dirty);
      CREATE TABLE IF NOT EXISTS sync_ctx (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO sync_ctx(id, applying) VALUES (1, 0);
      UPDATE sync_ctx SET applying = 0;
      CREATE TABLE IF NOT EXISTS sync_tombstones (kind TEXT NOT NULL, cloud_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(kind, cloud_id));
      CREATE TABLE IF NOT EXISTS drive_jobs (video_id INTEGER PRIMARY KEY, session_url TEXT, size INTEGER, started_at INTEGER);
    `);
    // Local edits mark a row dirty (pushed to the cloud later); rows written by the sync itself
    // (sync_ctx.applying = 1) don't, so remote changes never bounce back.
    const trig = (t, colsList) => this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${t}_ins AFTER INSERT ON ${t} WHEN (SELECT applying FROM sync_ctx WHERE id=1) = 0
        BEGIN UPDATE ${t} SET dirty = 1 WHERE id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS trg_${t}_upd AFTER UPDATE OF ${colsList} ON ${t} WHEN (SELECT applying FROM sync_ctx WHERE id=1) = 0
        BEGIN UPDATE ${t} SET dirty = 1 WHERE id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS trg_${t}_del AFTER DELETE ON ${t} WHEN OLD.cloud_id IS NOT NULL AND (SELECT applying FROM sync_ctx WHERE id=1) = 0
        BEGIN INSERT OR REPLACE INTO sync_tombstones(kind, cloud_id, ts) VALUES ('${t}', OLD.cloud_id, CAST(strftime('%s','now') AS INTEGER) * 1000); END;`);
    trig('channels', 'name, handle, yt_channel_id, folder, style, status, status_reason, paused_until, profile_id, last_run');
    trig('profiles', 'number, name, proxy_id');
    trig('videos', 'status, scheduled_at, title, description, tags, hashtags, edited, ai_status, ai_error, url, error, attempts, uploaded_at, drive_file_id, filename, size');
  }

  /** Run fn with change tracking off (used when applying changes that came from the cloud). */
  applying(fn) {
    this.db.exec('UPDATE sync_ctx SET applying = 1 WHERE id = 1');
    try { return fn(); } finally { this.db.exec('UPDATE sync_ctx SET applying = 0 WHERE id = 1'); }
  }
  _p(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }
  static _clean(params) { return params.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)); }
  run(sql, ...params) {
    const r = this._p(sql).run(...DB._clean(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  get(sql, ...params) { const r = this._p(sql).get(...DB._clean(params)); return r ? { ...r } : undefined; }
  all(sql, ...params) { return this._p(sql).all(...DB._clean(params)).map(r => ({ ...r })); }
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { try { this.db.close(); } catch (_) { /* ignore */ } }
}

module.exports = { DB };
