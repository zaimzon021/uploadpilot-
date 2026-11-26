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
