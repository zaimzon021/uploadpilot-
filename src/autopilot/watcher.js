'use strict';
// Watches a channel folder for new videos/thumbnails (chokidar). Waits until files stop growing.
const path = require('path');
const chokidar = require('chokidar');
const { isVideo, isThumb, DONE_DIR } = require('./scanner');

function watchFolder(folder, { onVideo, onThumb, onReady, stabilityMs = 2000, pollInterval = 250, usePolling = false } = {}) {
  const watcher = chokidar.watch(folder, {
    depth: 0, ignoreInitial: true, usePolling, interval: 500,
    ignored: p => path.basename(p) === DONE_DIR || path.basename(p).startsWith('.') || path.basename(p).startsWith('~$'),
    awaitWriteFinish: { stabilityThreshold: stabilityMs, pollInterval },
  });
  watcher.on('add', p => {
    if (path.dirname(path.resolve(p)) !== path.resolve(folder)) return;
    if (isVideo(p) && onVideo) onVideo(p);
    else if (isThumb(p) && onThumb) onThumb(p);
  });
  watcher.on('error', () => {});
  if (onReady) watcher.on('ready', onReady);
  return { close: () => watcher.close(), watcher };
}

module.exports = { watchFolder };
