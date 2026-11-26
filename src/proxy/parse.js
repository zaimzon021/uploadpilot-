'use strict';
// Parse proxy lines "host:port:user:pass" (also accepts "host:port" and "socks5://user:pass@host:port").
function parseProxyLine(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  let m = /^socks5h?:\/\/(?:([^:@]+):([^@]*)@)?([^:\/]+):(\d+)\/?$/i.exec(s);
  if (m) return validate({ host: m[3], port: +m[4], username: m[1] ? decodeURIComponent(m[1]) : null, password: m[2] ? decodeURIComponent(m[2]) : null });
  const parts = s.split(':');
  if (parts.length < 2) throw new Error(`Bad proxy line: "${s}"`);
  const [host, port, username, ...rest] = parts;
  const password = rest.length ? rest.join(':') : null; // password may itself contain ':'
  return validate({ host, port: +port, username: username || null, password });
}
function validate(p) {
  if (!p.host || !/^[A-Za-z0-9.\-\[\]]+$/.test(p.host)) throw new Error(`Bad proxy host: "${p.host}"`);
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error(`Bad proxy port: "${p.port}"`);
  if ((p.username && p.password == null)) throw new Error('Proxy user given without password');
  return p;
}
function parseProxyList(text) {
  const ok = [], errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    try { const p = parseProxyLine(line); if (p) ok.push(p); } catch (e) { errors.push({ line: i + 1, error: e.message }); }
  });
  return { proxies: ok, errors };
}
function proxyLabel(p) { return p ? `${p.host}:${p.port}` : '—'; }
module.exports = { parseProxyLine, parseProxyList, proxyLabel };
