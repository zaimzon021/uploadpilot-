'use strict';
// Run the UploadPilot core without Electron (API + autopilot). Useful for servers and debugging.
//   node src/headless.js [--data <dir>]
const path = require('path');
const os = require('os');
const { UploadPilotApp } = require('./core/app');

const argv = process.argv.slice(2);
const dataIdx = argv.indexOf('--data');
const dataDir = dataIdx >= 0 ? argv[dataIdx + 1] : (process.env.UPLOADPILOT_DATA || path.join(os.homedir(), '.uploadpilot'));

(async () => {
  const app = new UploadPilotApp({ dataDir });
  await app.start();
  console.log(`UploadPilot core running. Data: ${dataDir}`);
  console.log(`API: ${app.api.url}`);
  const shutdown = async () => { console.log('Shutting down…'); await app.stop(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
})().catch(e => { console.error(e); process.exit(1); });
