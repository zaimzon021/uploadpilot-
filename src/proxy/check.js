'use strict';
// Proxy health check: open a tunnel through the upstream SOCKS5 (with auth) and fetch the exit IP.
const tls = require('tls');
const { SocksClient } = require('socks');

function httpGetOverSocket(socket, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const done = (err, val) => { clearTimeout(t); try { s.destroy(); } catch (_) {} err ? reject(err) : resolve(val); };
    const t = setTimeout(() => done(new Error('Proxy check timed out')), timeoutMs);
    const s = isHttps ? tls.connect({ socket, servername: u.hostname }) : socket;
    let data = Buffer.alloc(0);
    s.on('data', c => { data = Buffer.concat([data, c]); });
    s.on('error', e => done(e));
    s.on('end', () => {
      const text = data.toString('utf8');
      const idx = text.indexOf('\r\n\r\n');
      const head = text.slice(0, idx); let body = text.slice(idx + 4);
      const status = +(/^HTTP\/1\.[01] (\d+)/.exec(head) || [])[1];
      if (/transfer-encoding:\s*chunked/i.test(head)) body = dechunk(body);
      done(null, { status, body });
    });
    const send = () => s.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: UploadPilot-ProxyCheck\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    if (isHttps) s.once('secureConnect', send); else send();
  });
}
function dechunk(body) {
  let out = '', rest = body;
  while (rest.length) {
    const i = rest.indexOf('\r\n'); if (i < 0) break;
    const n = parseInt(rest.slice(0, i), 16); if (!n) break;
    out += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2);
  }
  return out;
}

function extractIp(body) {
  try { const j = JSON.parse(body); if (j.ip) return String(j.ip); if (j.origin) return String(j.origin); } catch (_) { /* text */ }
  const m = /(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})/i.exec(body);
  return m ? m[1] : null;
}

/** @returns {Promise<{ok:boolean, ip?:string, ms:number, error?:string}>} */
async function checkProxy(proxy, { url = 'https://api.ipify.org?format=json', timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  try {
    const u = new URL(url);
    const port = +(u.port || (u.protocol === 'https:' ? 443 : 80));
    const { socket } = await SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username || undefined, password: proxy.password || undefined },
      command: 'connect', destination: { host: u.hostname, port }, timeout: timeoutMs,
    });
    const res = await httpGetOverSocket(socket, url, timeoutMs);
    if (res.status !== 200) throw new Error(`Exit-IP service answered HTTP ${res.status}`);
    const ip = extractIp(res.body);
    if (!ip) throw new Error('Could not read exit IP from response');
    return { ok: true, ip, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

module.exports = { checkProxy, extractIp };
