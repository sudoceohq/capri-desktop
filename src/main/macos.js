'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { execFile, spawn } = require('node:child_process');
const electron = require('electron');
const { app } = electron;
const { classify, isBrowser, browserControl } = require('./rivals');

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
  const wins = snap.wins.map((w) => ({
    id: w.id, x: w.x - bounds.x, y: w.y - bounds.y, w: w.w, h: w.h, max: w.max,
  })).filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
  const flags = classify(snap);
  return { fg: snap.fg, ai: flags.ai, pages: flags.pages, dl: flags.dl, wins };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let askedAccess = false;

function promptAccessibility() {
  if (askedAccess) return;
  askedAccess = true;
  // The panel names Capri. This asks for the app the user sees, not the helper binary.
  electron.systemPreferences?.isTrustedAccessibilityClient?.(true);
}

function osaResult(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 20000 }, (err, out, errText) => {
      if (!err) return resolve({ ok: true, out: String(out ?? ''), denied: false });
      const why = `${err.message || ''} ${errText || ''}`;
      resolve({ ok: false, out: '', denied: /assistive|not allowed|not authorized|-1719|-1743|-1002/i.test(why) });
    });
  });
}

function safeName(name) {
  return /^[A-Za-z0-9 .]+$/.test(name) ? name : null;
}

function dictionaryScript(plan) {
  const appName = safeName(plan.app);
  if (!appName || (plan.tab !== 'active tab' && plan.tab !== 'current tab')) return null;
  return `tell application "${appName}"
if (count of windows) is 0 then error "no window"
close ${plan.tab} of front window
end tell`;
}

function keyScript(appName) {
  const name = safeName(appName);
  if (!name) return null;
  // Command only. Shift, Option, or Control would close the window or the other tabs.
  return `tell application "System Events" to tell process "${name}"
set frontmost to true
keystroke "w" using command down
end tell`;
}

function targetPid(snap, id) {
  const win = (snap.wins || []).find((w) => Number(w.id) === Number(id));
  const fromWin = Number(win?.pid) || 0;
  if (fromWin > 0) return fromWin;
  if (Number(snap.fg) === Number(id)) return Number(snap.frontPid) || 0;
  return 0;
}

function rivalStill(snap, key) {
  const flags = classify(snap);
  return flags.pages.includes(key) || (Boolean(flags.dl) && flags.ai.includes(key));
}

function gate(snap, id, key) {
  if (!snap?.trusted) return 'access';
  if (Number(snap.fg) !== Number(id)) return 'front';
  if (!isBrowser(snap)) return 'browser';
  if (!rivalStill(snap, key)) return 'page';
  return '';
}

function pageClosed(id, snap, key) {
  if (!Array.isArray(snap?.wins)) return false;
  // The last tab takes its window with it, so an empty list counts once that id is gone.
  if (!snap.wins.some((w) => Number(w.id) === Number(id))) return true;
  if (!snap.trusted || Number(snap.fg) !== Number(id)) return false;
  return !rivalStill(snap, key);
}

async function describeFront() {
  let snap;
  try { snap = await run('snapshot', '0'); } catch { return null; }
  if (snap.trusted && snap.bundle) return snap;
  const read = await osaResult(`tell application "System Events"
set p to first application process whose frontmost is true
return (bundle identifier of p) & linefeed & (name of front window of p)
end tell`);
  if (!read.ok) return { ...snap, trusted: false, denied: read.denied };
  const [bundle = '', ...rest] = String(read.out).replace(/\r/g, '').split('\n');
  const title = rest.join('\n').trim();
  if (!bundle.trim() || !title) return { ...snap, trusted: false, denied: false };
  return { ...snap, trusted: true, bundle: bundle.trim(), title, via: 'events' };
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
    // Close the rival page in window `id`. A posted Command-W reports success and hits whichever
    // app is key, so this brings that browser forward and uses its own close-tab command when it
    // has one. '' once the tab is gone; 'access' when Accessibility or Automation is missing.
    async close(id, key) {
      let snap;
      try { snap = await run('snapshot', '0'); } catch { return 'gone'; }
      const pid = targetPid(snap, id);
      if (!pid) return 'front';
      let guard;
      try { guard = await run('focus', pid); } catch { return 'gone'; }
      if (guard.held) return 'keys';
      if (!guard.ok) return 'front';
      try { snap = await describeFront(); } catch { return 'gone'; }
      if (!snap) return 'gone';
      if (!snap.trusted) {
        if (snap.denied) promptAccessibility();
        return snap.denied ? 'access' : 'front';
      }
      const blocked = gate(snap, id, key);
      if (blocked) return blocked;
      const plan = browserControl(snap.bundle);
      if (!plan) return 'browser';
      const helperTrusted = snap.via !== 'events';
      let denied = false;

      const sendable = async () => {
        let again;
        try { again = await run('focus', pid); } catch { return 'gone'; }
        if (!again.held) return '';
        const now = await describeFront();
        if (now && pageClosed(id, now, key)) return '';
        return 'keys';
      };
      const act = async (script) => {
        if (!script) return false;
        const result = await osaResult(script);
        if (result.denied) denied = true;
        return result.ok;
      };
      const confirmedGone = async (tries) => {
        for (let i = 0; i < tries; i++) {
          if (i) await sleep(300);
          try { await run('focus', pid); } catch { /* a title from the snapshot still counts */ }
          const after = await describeFront();
          if (after && pageClosed(id, after, key)) return true;
        }
        return false;
      };

      if (plan.tab) {
        const ready = await sendable();
        if (ready) return ready;
        // The browser accepted the close. A second command would take the next tab too.
        const ran = await act(dictionaryScript(plan));
        if (await confirmedGone(ran ? 4 : 2)) return '';
        if (ran) return 'late';
      }
      // A refused AppleEvent is not a reason to skip the keystroke. System Events can still
      // reach the browser when Automation for that app has not been allowed yet.
      {
        const ready = await sendable();
        if (ready) return ready;
        const now = await describeFront();
        if (!now) return 'gone';
        if (pageClosed(id, now, key)) return '';
        const still = gate(now, id, key);
        if (still) return still;
        const typed = await act(keyScript(plan.app));
        if (await confirmedGone(typed ? 4 : 2)) return '';
        if (typed) return 'late';
      }
      if (!denied && helperTrusted) {
        let keyed;
        try { keyed = await run('close-tab', pid); } catch { return 'gone'; }
        if (keyed.why === 'keys') return 'keys';
        if (keyed.why === 'access') denied = true;
        else if (await confirmedGone(keyed.ok ? 4 : 2)) return '';
        if (keyed.ok) return 'late';
      }
      if (denied) {
        promptAccessibility();
        return 'access';
      }
      return 'late';
    },
    stop() { stopped = true; clearTimeout(retry); child?.kill(); },
  };
}

module.exports = { run, startWindowWatch, toOverlay };
