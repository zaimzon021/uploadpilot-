'use strict';
// Local unauthenticated SOCKS5 server on 127.0.0.1:<random port> that forwards every CONNECT
// through an upstream SOCKS5 proxy WITH username/password auth (Chromium can't do SOCKS5 auth).
// Chromium is pointed at socks5://127.0.0.1:<port>; hostnames are passed through, so DNS is
// resolved by the upstream proxy (no local DNS leak).
const net = require('net');
const { SocksClient } = require('socks');

const REP = { OK: 0x00, FAIL: 0x01, NOT_ALLOWED: 0x02, NET_UNREACH: 0x03, HOST_UNREACH: 0x04, REFUSED: 0x05, CMD_UNSUPPORTED: 0x07, ATYP_UNSUPPORTED: 0x08 };

function reply(sock, code) {
  // BND.ADDR 0.0.0.0:0 — clients (Chromium) ignore it for CONNECT
  try { sock.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch (_) { /* ignore */ }
}

class SocksBridge {
  /** @param {{host,port,username,password}} upstream */
  constructor(upstream, { connectTimeoutMs = 20000, onError } = {}) {
    this.upstream = upstream;
    this.connectTimeoutMs = connectTimeoutMs;
    this.onError = onError || (() => {});
    this.server = null; this.port = null;
    this.sockets = new Set();
    this.stats = { connections: 0, failures: 0 };
  }

  get url() { return `socks5://127.0.0.1:${this.port}`; }

  start(port = 0) {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(s => this._handle(s));
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this); });
    });
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server) await new Promise(r => this.server.close(() => r()));
    this.server = null;
  }

  _track(s) { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); s.on('error', () => {}); }

  _handle(client) {
    this._track(client);
    let buf = Buffer.alloc(0);
    let stage = 'greeting';
    const onData = async chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return client.destroy();
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0x00)) { client.end(Buffer.from([0x05, 0xff])); return; }
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const [ver, cmd, , atyp] = buf;
        if (ver !== 0x05) return client.destroy();
        let host, off;
        if (atyp === 0x01) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else if (atyp === 0x03) { const len = buf[4]; if (buf.length < 5 + len + 2) return; host = buf.subarray(5, 5 + len).toString('utf8'); off = 5 + len; }
        else if (atyp === 0x04) {
          if (buf.length < 22) return;
          const b = buf.subarray(4, 20); const parts = [];
          for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
          host = parts.join(':'); off = 20;
        } else { reply(client, REP.ATYP_UNSUPPORTED); return client.end(); }
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        stage = 'connecting';
        client.removeListener('data', onData);
        client.pause();
        if (cmd !== 0x01) { reply(client, REP.CMD_UNSUPPORTED); return client.end(); }
        this.stats.connections++;
        try {
          const { socket } = await SocksClient.createConnection({
            proxy: { host: this.upstream.host, port: this.upstream.port, type: 5, userId: this.upstream.username || undefined, password: this.upstream.password || undefined },
            command: 'connect', destination: { host, port }, timeout: this.connectTimeoutMs,
          });
          this._track(socket);
          if (client.destroyed) return socket.destroy();
          reply(client, REP.OK);
          if (rest.length) socket.write(rest);
          socket.pipe(client); client.pipe(socket);
          client.resume();
          socket.on('close', () => client.destroy());
          client.on('close', () => socket.destroy());
        } catch (e) {
          this.stats.failures++;
          this.onError(e, { host, port });
          reply(client, /auth/i.test(e.message) ? REP.NOT_ALLOWED : REP.HOST_UNREACH);
          client.end();
        }
      }
    };
    client.on('data', onData);
  }
}

module.exports = { SocksBridge };
