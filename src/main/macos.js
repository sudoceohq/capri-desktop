'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { execFile, spawn } = require('node:child_process');
const { app } = require('electron');
const { classify, isBrowser } = require('./rivals');

const helper = () => app.isPackaged
  ? path.join(process.resourcesPath, 'capri-macos')
  : path.resolve(__dirname, '../../native/bin/capri-macos');

function run(command, ...args) {
  return new Promise((resolve, reject) => {
    execFile(helper(), [command, ...args.map(String)], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (error) { reject(error); }
    });
  });
}

// No pixel conversion on macOS: Quartz window bounds and Electron bounds are both points.
// `title` and `bundle` stay here. The overlay only hears which rival matched.
function toOverlay(snap, bounds) {
  const wins = snap.wins.map(({ pid, ...w }) => ({ ...w, x: w.x - bounds.x, y: w.y - bounds.y }))
    .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
  const flags = classify(snap);
  return { fg: snap.fg, ai: flags.ai, pages: flags.pages, dl: flags.dl, wins };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function targetPid(snap, id) {
  const win = (snap.wins || []).find((w) => Number(w.id) === Number(id));
  const fromWin = Number(win?.pid) || 0;
  if (fromWin > 0) return fromWin;
  if (Number(snap.fg) === Number(id)) return Number(snap.frontPid) || 0;
  return 0;
}

function rivalPage(snap, key) {
  const flags = classify(snap);
  return flags.pages.includes(key) || (Boolean(flags.dl) && flags.ai.includes(key));
}

function pageClosed(id, snap, key) {
  if (!Array.isArray(snap?.wins)) return false;
  if (!snap.wins.some((w) => Number(w.id) === Number(id))) return true;
  if (!snap.trusted || Number(snap.fg) !== Number(id)) return false;
  return !rivalPage(snap, key);
}

function startWindowWatch({ overlay, onUpdate }) {
  let child;
  let retry;
  let stopped = false;
  let restarts = 0;
  let previousApp = null;
  let last = null;
  const send = () => {
    if (last && !overlay.isDestroyed()) onUpdate(toOverlay(last, overlay.getBounds()));
  };
  const start = () => {
    if (stopped || overlay.isDestroyed()) return;
    const id = overlay.getMediaSourceId().split(':')[1];
    child = spawn(helper(), ['watch', id, String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (overlay.isDestroyed()) return;
      try {
        const snap = JSON.parse(line);
        if (Number.isInteger(snap.frontPid) && snap.frontPid > 0 && snap.frontPid !== process.pid) previousApp = snap.frontPid;
        last = snap;
        send();
      } catch { /* incomplete snapshot */ }
    });
    child.stderr.on('data', (d) => console.error('[capri] macOS window watch:', String(d).trim()));
    child.on('error', (err) => console.error('[capri] macOS helper:', err.message, '(run npm run native:mac)'));
    child.once('close', () => {
      lines.close();
      child = null;
      if (!stopped && restarts++ < 3) retry = setTimeout(start, 3000);
    });
  };
  start();
  return {
    restoreFocus() { return previousApp ? run('restore-focus', process.pid, previousApp) : Promise.resolve(); },
    refresh: send,
    // The zap can land after Capri's window is key, and a global Command-W then misses the browser.
    // Bring that app forward, send Command-W only while its page is front, and try once more.
    async close(id, key) {
      const once = async () => {
        let snap;
        try { snap = await run('snapshot', '0'); } catch { return 'gone'; }
        if (Array.isArray(snap.wins) && snap.wins.length && !snap.wins.some((w) => Number(w.id) === Number(id))) return '';
        const pid = targetPid(snap, id);
        if (!pid) return snap.trusted ? 'front' : 'keys';
        let raised;
        try { raised = await run('focus', pid); } catch { return 'gone'; }
        if (raised.why === 'keys') return 'keys';
        if (!raised.ok) return raised.why || 'front';
        try { snap = await run('snapshot', '0'); } catch { return 'gone'; }
        if (!snap.trusted) return 'keys';
        if (Number(snap.fg) !== Number(id)) return 'front';
        if (!isBrowser(snap)) return 'browser';
        if (!rivalPage(snap, key)) return 'page';
        let sent;
        try { sent = await run('close-tab', pid); } catch { return 'gone'; }
        if (sent.why === 'keys') return 'keys';
        if (!sent.ok) return sent.why || 'front';
        try { snap = await run('snapshot', '0'); } catch { return 'gone'; }
        if (pageClosed(id, snap, key)) return '';
        await sleep(250);
        try { snap = await run('snapshot', '0'); } catch { return 'gone'; }
        return pageClosed(id, snap, key) ? '' : 'stuck';
      };
      let why = await once();
      if (why !== '') {
        const again = await once();
        // The first key can land just after its check. A different page, or no window, is the close.
        why = again === '' || (why === 'stuck' && again === 'page') ? '' : again;
      }
      if (why !== '') console.error(`[capri] rival tab close gave up: ${why}`);
      return why;
    },
    stop() { stopped = true; clearTimeout(retry); child?.kill(); },
  };
}

module.exports = { run, startWindowWatch, toOverlay };
