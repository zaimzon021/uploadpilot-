'use strict';
// Activity feed + app log. Persists to `events` table and streams to listeners (SSE).
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

class Events extends EventEmitter {
  constructor(db, logDir) {
    super();
    this.db = db; this.logDir = logDir;
    this.setMaxListeners(100);
    if (logDir) fs.mkdirSync(logDir, { recursive: true });
  }
  log(level, message, { channelId = null, kind = 'info' } = {}) {
    const ts = Date.now();
    const r = this.db.run('INSERT INTO events(ts,level,channel_id,kind,message) VALUES(?,?,?,?,?)', ts, level, channelId, kind, message);
    const ev = { id: r.lastInsertRowid, ts, level, channel_id: channelId, kind, message };
    if (this.logDir) {
      const day = new Date(ts).toISOString().slice(0, 10);
      fs.appendFile(path.join(this.logDir, `app-${day}.log`), `${new Date(ts).toISOString()} [${level}] ${channelId ? `ch${channelId} ` : ''}${kind}: ${message}\n`, () => {});
    }
    if (process.env.UPLOADPILOT_VERBOSE) console.log(`[${level}] ${channelId ? `ch${channelId} ` : ''}${message}`);
    this.emit('event', ev);
    return ev;
  }
  info(m, o) { return this.log('info', m, o); }
  warn(m, o) { return this.log('warn', m, o); }
  error(m, o) { return this.log('error', m, o); }
  success(m, o) { return this.log('success', m, o); }
  recent(limit = 50) { return this.db.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit); }
}

module.exports = { Events };
