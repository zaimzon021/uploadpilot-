'use strict';
// CI helper: writes config/cloud.secret.json from the OAUTH_CLIENT_SECRET env (GitHub secret) so the
// packaged app can finish the Google Drive sign-in. Skip-safe: no secret -> nothing written, exit 0.
const fs = require('fs');
const path = require('path');
const secret = (process.env.OAUTH_CLIENT_SECRET || '').trim();
const out = path.join(__dirname, '..', 'config', 'cloud.secret.json');
if (!secret) { console.log('OAUTH_CLIENT_SECRET not set: skipping (users can paste the secret in Settings > Cloud)'); process.exit(0); }
fs.writeFileSync(out, JSON.stringify({ google: { clientSecret: secret } }));
console.log(`OAuth client secret written to ${path.relative(process.cwd(), out)} (${secret.length} chars)`);
