'use strict';
// Google OAuth for an installed ("Desktop app") client: loopback redirect + PKCE.
// Scope drive.file only (the app sees only files it created). The refresh token is kept in the
// SecretStore (Electron safeStorage on Windows). Endpoints are configurable so tests use a mock.
const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DEFAULT_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://www.googleapis.com/drive/v3/about?fields=user',
};
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class GoogleAuth {
  /**
   * @param {object} o
   * @param {string} o.clientId
   * @param {string} [o.clientSecret]   Desktop clients have one; Google treats it as non-secret
   * @param {import('./secretStore').SecretStore} o.secrets
   * @param {(url:string)=>any} [o.openExternal]   opens the system browser (Electron shell.openExternal)
   * @param {object} [o.endpoints]
   * @param {Function} [o.fetchImpl]
   */
  constructor({ clientId, clientSecret = '', secrets, openExternal = null, endpoints = {}, fetchImpl = globalThis.fetch, secretKey = 'googleDrive' }) {
    Object.assign(this, { clientId, clientSecret, secrets, openExternal, fetch: fetchImpl, secretKey });
    this.ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this._access = null; // { token, exp }
    this._pending = null;
  }

  get connected() { return !!(this.secrets.get(this.secretKey) || {}).refresh_token; }
  get account() { return (this.secrets.get(this.secretKey) || {}).email || null; }

  /**
   * Start the browser sign-in. Resolves { url, done } right away; `done` resolves when Google
   * redirects back to the loopback port (or rejects on error / timeout).
   */
  async begin({ timeoutMs = 5 * 60000 } = {}) {
    if (!this.clientId) throw Object.assign(new Error('Google OAuth client ID is not set (Settings → Cloud)'), { status: 400 });
    if (!this.clientSecret) throw Object.assign(new Error('OAuth client secret is not set — paste it in Settings → Cloud (Google Cloud Console → Credentials → your Desktop client)'), { status: 400 });
    if (this._pending) this._pending.cancel();
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const server = http.createServer();
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const url = `${this.ep.auth}?${new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true' })}`;   // account chooser: pick the Google account whose Drive to use
    let timer, cancel;
    const done = new Promise((resolve, reject) => {
      cancel = () => { clearTimeout(timer); server.close(); reject(new Error('Google sign-in cancelled')); };
      timer = setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out')); }, timeoutMs);
      server.on('request', async (req, res) => {
        const q = new URL(req.url, redirectUri).searchParams;
        if (!q.get('code') && !q.get('error')) { res.writeHead(404); return res.end(); }
        const page = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<html><body style="font-family:sans-serif;background:#0f0f10;color:#eee;padding:40px"><h2>UploadPilot</h2><p>${msg}</p><p>You can close this tab.</p></body></html>`); };
        clearTimeout(timer); server.close();
        if (q.get('error')) { page('Google Drive was not connected.'); return reject(new Error(`Google sign-in: ${q.get('error')}`)); }
        if (q.get('state') !== state) { page('Security check failed.'); return reject(new Error('OAuth state mismatch')); }
        try { const r = await this._exchange(q.get('code'), verifier, redirectUri); page('Google Drive connected.'); resolve(r); }
        catch (e) { page('Could not finish connecting Google Drive.'); reject(e); }
      });
    });
    done.catch(() => {});
    this._pending = { cancel };
    if (this.openExternal) await this.openExternal(url);
    const wrapped = done.finally(() => { this._pending = null; });
    wrapped.catch(() => {});   // handled by whoever awaits it; never an unhandled rejection
    return { url, redirectUri, done: wrapped };
  }

  async _exchange(code, verifier, redirectUri) {
    const body = new URLSearchParams({ code, client_id: this.clientId, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const res = await this.fetch(this.ep.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.refresh_token) throw new Error(`Token exchange failed: ${j.error_description || j.error || res.status}${!j.refresh_token && res.ok ? ' (no refresh token returned)' : ''}`);
    this._access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
    let email = null;
    try { const r = await this.fetch(this.ep.userinfo, { headers: { Authorization: `Bearer ${j.access_token}` } }); const u = await r.json(); email = u.user && u.user.emailAddress || null; } catch (_) { /* optional */ }
    this.secrets.set(this.secretKey, { refresh_token: j.refresh_token, scope: j.scope || SCOPE, email, connectedAt: Date.now() });
    return { email };
  }

  /** Valid access token (refreshes with the stored refresh token). */
  async accessToken() {
    if (this._access && this._access.exp > Date.now()) return this._access.token;
    const s = this.secrets.get(this.secretKey);
    if (!s || !s.refresh_token) throw Object.assign(new Error('Google Drive is not connected'), { code: 'DRIVE_NOT_CONNECTED' });
    const body = new URLSearchParams({ client_id: this.clientId, refresh_token: s.refresh_token, grant_type: 'refresh_token' });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const res = await this.fetch(this.ep.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (j.error === 'invalid_grant') { this.secrets.delete(this.secretKey); throw Object.assign(new Error('Google Drive access was revoked or expired — connect again in Settings → Cloud'), { code: 'DRIVE_NOT_CONNECTED', revoked: true }); }
      throw new Error(`Google token refresh failed: ${j.error || res.status}`);
    }
    this._access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
    return this._access.token;
  }

  async disconnect() {
    const s = this.secrets.get(this.secretKey);
    this.secrets.delete(this.secretKey); this._access = null;
    if (s && s.refresh_token) { try { await this.fetch(`${this.ep.revoke}?token=${encodeURIComponent(s.refresh_token)}`, { method: 'POST' }); } catch (_) { /* best effort */ } }
  }
}

module.exports = { GoogleAuth, SCOPE };
