'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { desktopArea } = require('../src/main/desktop-area');
const { TRAY, trayLabels } = require('../src/main/labels');

// Inject OS/process boundaries without starting native processes or changing process.platform.
function load(name, platform, mocks = {}, env = {}, extraProcess = {}) {
  const file = path.resolve(__dirname, '../src/main', name);
  const realRequire = createRequire(file);
  const localRequire = (id) => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id);
  const module = { exports: {} };
  const proc = { platform, pid: 1234, env: { ...env }, resourcesPath: '/Capri.app/Contents/Resources', execPath: '/Capri.exe', ...extraProcess };
  new Function('require', 'module', 'exports', '__dirname', 'process', fs.readFileSync(file, 'utf8').replace(/^#![^\n]*\n/, ''))(
    localRequire, module, module.exports, path.dirname(file), proc,
  );
  return module.exports;
}
function browserModule(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${browserModule(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const display = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 805 } };
test('Mac text panels can reclaim native focus after switching apps without reopening chat', async (t) => {
  globalThis.innerWidth = 1440; globalThis.innerHeight = 900;
  globalThis.matchMedia = () => ({ matches: false });
  t.after(() => { delete globalThis.innerWidth; delete globalThis.innerHeight; delete globalThis.matchMedia; });
  const { Panel } = await import(browserModule(path.resolve(__dirname, '../src/renderer/js/panel.js')));
  const element = () => ({
    hidden: false, listeners: new Map(), children: new Map(),
    addEventListener(type, fn, capture) { this.listeners.set(type, { fn, capture }); },
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, element());
      return this.children.get(selector);
    },
    contains(target) { return target === this; },
  });
  let focused = false; let requests = 0;
  const panel = new Panel({ panel: element(), ticker: element(), labels: {},
    focusChat: () => { focused = true; requests++; } });
  panel.current = { chat: {} };
  const down = panel.el.listeners.get('pointerdown');
  assert.equal(down.capture, true); // input/form click propagation cannot suppress activation
  for (let i = 0; i < 2; i++) {
    focused = false; // another app now owns the keyboard; DOM focus may not change
    down.fn({ button: 0, target: panel.chatInput });
    assert.equal(focused, true);
  }
  assert.equal(requests, 2);
  down.fn({ button: 2, target: panel.chatInput });
  down.fn({ button: 0, target: panel.chatClose });
  panel.el.hidden = true; down.fn({ button: 0, target: panel.chatInput });
  panel.el.hidden = false; panel.suspended = true; down.fn({ button: 0, target: panel.chatInput });
  panel.suspended = false; panel.current = { kind: 'info' }; down.fn({ button: 0, target: panel.el });
  assert.equal(requests, 2);
  const windowsPanel = new Panel({ panel: element(), ticker: element(), labels: {} });
  assert.equal(windowsPanel.el.listeners.has('pointerdown'), false);
});
test('macOS resting leaves menu bar clear and extends over bottom Dock only', () => {
  assert.deepEqual(desktopArea(display, 'corner', 'darwin'), { area: display.workArea, gap: 0 });
  assert.deepEqual(desktopArea(display, 'taskbar', 'darwin'), {
    area: { x: 0, y: 25, width: 1440, height: 875 }, gap: 70,
  });
  const left = { bounds: { x: -1920, y: -300, width: 1920, height: 1080 }, workArea: { x: -1850, y: -275, width: 1850, height: 1055 } };
  assert.deepEqual(desktopArea(left, 'taskbar', 'darwin'), { area: left.workArea, gap: 0 });
});
test('Windows corner/taskbar bounds retain upstream fullscreen-avoidance geometry', () => {
  assert.deepEqual(desktopArea(display, 'corner', 'win32'), { area: display.workArea, gap: 0 });
  assert.deepEqual(desktopArea(display, 'taskbar', 'win32'), {
    area: { x: 0, y: 1, width: 1440, height: 899 }, gap: 70,
  });
});
test('macOS translations do not mutate any Windows or assistant wording', async () => {
  const { LINES, linesFor } = await import(browserModule(path.resolve(__dirname, '../src/renderer/js/lines.js')));
  for (const lang of Object.keys(LINES)) {
    const original = JSON.stringify(LINES[lang]);
    const mac = linesFor(lang, 'codex', 'darwin');
    assert.match(mac.setup.pasteHow, /macOS/);
    const strings = (v) => typeof v === 'string' ? [v] : Object.values(v).flatMap(strings);
    assert.doesNotMatch(strings(mac.setup).join('\n'), /Windows|Start menu|winget/i);
    assert.doesNotMatch(mac.guide.icon.hidden, /Windows|\^/);
    assert.doesNotMatch(mac.welcome.readyHow, /Ctrl\+Alt/);
    assert.match(mac.welcome.readyHow, /⌘⌥C/);
    assert.match(mac.welcome.noClaude, /Mac/);
    assert.match(mac.jealous.blocked, /Capri/);
    assert.doesNotMatch(mac.jealous.blocked, /\bPC\b/);
    assert.equal(JSON.stringify(LINES[lang]), original);
    assert.equal(linesFor(lang, 'claude', 'win32'), LINES[lang]);
    assert.equal(trayLabels(lang, 'win32'), TRAY[lang]);
    assert.doesNotMatch(trayLabels(lang, 'darwin').startup, /Windows/);
  }
});
test('macOS watch coordinates stay in points, including negative displays', () => {
  const mac = load('macos.js', 'darwin', { electron: { app: { isPackaged: false } } });
  assert.deepEqual(mac.toOverlay({ fg: 12, wins: [
    { id: 12, pid: 9, x: -1000, y: 60, w: 600, h: 400, max: false },
    { id: 13, pid: 4, x: 500, y: 60, w: 600, h: 400, max: false },
  ] }, { x: -1440, y: 25, width: 1440, height: 875 }), {
    fg: 12, ai: [], pages: [], dl: false, wins: [{ id: 12, x: 440, y: 35, w: 600, h: 400, max: false }],
  });
  const jealous = mac.toOverlay({
    fg: 3, title: 'ChatGPT - Google Chrome', bundle: 'com.google.Chrome', wins: [],
  }, { x: 0, y: 0, width: 1000, height: 800 });
  assert.equal(jealous.title, undefined);
  assert.equal(jealous.bundle, undefined);
  assert.deepEqual(jealous.pages, ['chatgpt']);
});
test('Windows watcher still uses PowerShell, physical-pixel conversion and taskbar state', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let killed = false; child.kill = () => { killed = true; };
  let invocation; let received; let dipCalls = 0;
  const watcher = load('windows.js', 'win32', {
    'node:child_process': { spawn(file, args, opts) { invocation = { file, args, opts }; return child; } },
    electron: { screen: { screenToDipRect(_, rect) { dipCalls++; return { x: rect.x / 2, y: rect.y / 2, width: rect.width / 2, height: rect.height / 2 }; } } },
  });
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(42n);
  const watch = watcher.startWindowWatch({ overlay: {
    getNativeWindowHandle: () => handle, isDestroyed: () => false,
    getBounds: () => ({ x: 100, y: 50, width: 1000, height: 700 }),
  }, onUpdate: (data) => { received = data; } });
  child.stdout.write(JSON.stringify({ fg: 5, taskbar: true, wins: [{ id: 5, x: 300, y: 200, w: 800, h: 600, max: false }] }) + '\n');
  assert.equal(invocation.file, 'powershell.exe');
  assert.ok(invocation.args.includes('Bypass'));
  assert.equal(invocation.args.at(-2), '42');
  assert.equal(dipCalls, 1);
  assert.deepEqual(received, {
    fg: 5, taskbar: true, ai: [], pages: [], dl: false, game: null, usb: [], plug: null,
    wins: [{ id: 5, x: 50, y: 50, w: 400, h: 300, max: false }],
  });
  watch.stop(); assert.equal(killed, true);
});
test('macOS panel dismissal remembers the external app across Capri activation', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => {};
  const calls = []; let received;
  const mac = load('macos.js', 'darwin', {
    electron: { app: { isPackaged: true } },
    'node:child_process': {
      spawn: () => child,
      execFile(file, args, _opts, done) { calls.push(args); done(null, '{"ok":true}'); },
    },
  });
  const watch = mac.startWindowWatch({ overlay: {
    isDestroyed: () => false, getMediaSourceId: () => 'window:42:0',
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  }, onUpdate: (data) => { received = data; } });
  await watch.restoreFocus(); assert.equal(calls.length, 0);
  for (const frontPid of [77, 1234]) child.stdout.write(JSON.stringify({ fg: 0, frontPid, wins: [] }) + '\n');
  await watch.restoreFocus();
  assert.deepEqual(calls, [['restore-focus', '1234', '77']]);
  assert.equal(received.frontPid, undefined);
  assert.deepEqual(received, { fg: 0, ai: [], pages: [], dl: false, wins: [] });
  watch.stop();
});
test('macOS app launch passes a discovered path as a single argument; unknown paths are rejected', async () => {
  const calls = [];
  const id = "/Applications/QA's Test App.app";
  const launch = load('launch.js', 'darwin', {
    electron: { shell: {} }, './apps': {},
    './macos': { run: async (command) => { assert.equal(command, 'installed'); return [{ name: 'QA Test', kind: 'app', id }]; } },
    'node:fs': { readFileSync() { throw new Error('no Steam'); }, readdirSync() { return []; } },
    'node:child_process': { execFile(file, args, done) { calls.push([file, args]); done(null); } },
  });
  await assert.rejects(launch.launch({ kind: 'app', id: '/tmp/unlisted.app' }), /not found/);
  await launch.launch({ kind: 'app', id });
  assert.deepEqual(calls, [['/usr/bin/open', ['-a', id]]]);
  assert.equal(await launch.media('unrecognized'), false);
});
test('macOS play, pause, and next tell Apple Music, and a failed script is not success', async () => {
  const scripts = [];
  let fail = false;
  const launch = load('launch.js', 'darwin', {
    electron: { shell: {} },
    './macos': { run: async () => { throw new Error('media keys are not used'); } },
    'node:fs': { readFileSync() { throw new Error('no Steam'); }, readdirSync() { return []; } },
    'node:child_process': {
      execFile(file, args, _opts, done) {
        scripts.push([file, args[1]]);
        done(fail ? new Error('denied') : null, '');
      },
    },
  });
  assert.equal(await launch.media('play'), true);
  assert.equal(await launch.media('pause'), true);
  assert.equal(await launch.media('next'), true);
  assert.deepEqual(scripts.map(([, script]) => script), [
    'tell application "Music" to play',
    'tell application "Music" to pause',
    'tell application "Music" to next track',
  ]);
  fail = true;
  assert.equal(await launch.media('play'), false);
});
test('concurrent macOS app requests share discovery and failed scans can be retried', async () => {
  let scans = 0; let finish; let fail;
  const launch = load('launch.js', 'darwin', {
    electron: { shell: {} }, './apps': {},
    './macos': { run: () => {
      scans++;
      return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    } },
    'node:fs': { readFileSync() { throw new Error('no Steam'); }, readdirSync() { return []; } },
  });
  const failed = [launch.launchables(), launch.launchables()];
  assert.equal(scans, 1);
  fail(new Error('inventory unavailable'));
  assert.ok((await Promise.allSettled(failed)).every((r) => r.status === 'rejected'));
  const pending = [launch.launchables(), launch.launchables(), launch.launchables()];
  assert.equal(scans, 2);
  const apps = [{ name: 'QA Test', kind: 'app', id: '/Applications/QA.app' }];
  finish(apps);
  assert.deepEqual(await Promise.all(pending), [apps, apps, apps]);
  assert.deepEqual(await launch.launchables(), apps);
  assert.equal(scans, 2);
});
test('macOS watcher refresh remaps unchanged windows after moving the overlay', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => {};
  let origin = 0; let received;
  const mac = load('macos.js', 'darwin', {
    electron: { app: { isPackaged: false } }, 'node:child_process': { spawn: () => child },
  });
  const watch = mac.startWindowWatch({ overlay: {
    isDestroyed: () => false, getMediaSourceId: () => 'window:42:0',
    getBounds: () => ({ x: origin, y: 25, width: 1000, height: 800 }),
  }, onUpdate: (data) => { received = data; } });
  child.stdout.write(JSON.stringify({ fg: 7, wins: [{ id: 7, x: 100, y: 100, w: 400, h: 300 }] }) + '\n');
  assert.equal(received.wins[0].x, 100);
  origin = 100; watch.refresh();
  assert.equal(received.wins[0].x, 0); assert.equal(received.wins[0].y, 75);
  watch.stop();
});
test('macOS Finder and Trash use native folder opening and report failure', async () => {
  const opened = []; let error = '';
  const launch = load('launch.js', 'darwin', {
    'node:path': path.posix, // simulate macOS path rules when this test runs on Windows CI
    electron: { app: { getPath: (key) => `/qa/${key}` }, shell: { openPath: async (dir) => { opened.push(dir); return error; } } },
    'node:os': { homedir: () => '/qa/home' },
    './macos': { run: async () => [] },
    'node:fs': { readdirSync: () => [], readFileSync() { throw new Error('no Steam'); } },
    'node:child_process': { spawn() { throw new Error('must not launch Explorer'); } },
  });
  assert.deepEqual(await launch.find('open finder'), { name: 'explorer', kind: 'known', id: 'explorer' });
  for (const id of ['explorer', 'recycle', 'downloads']) await launch.launch({ kind: 'known', id });
  assert.deepEqual(opened, ['/qa/home', '/qa/home/.Trash', '/qa/downloads']);
  error = 'permission denied';
  await assert.rejects(launch.launch({ kind: 'known', id: 'downloads' }), /permission denied/);
});
test('macOS desktop app bundles and scripts require the existing confirmation path', async () => {
  const launch = load('launch.js', 'darwin', {
    electron: { app: { getPath: () => '/qa/Desktop' } }, './macos': { run: async () => [] },
    'node:fs': { readFileSync() { throw new Error('no Steam'); }, readdirSync(dir) {
      return dir === '/qa/Desktop' ? [{ name: 'QA.app', isDirectory: () => true }] : [];
    } },
  });
  const bundle = await launch.find('open QA');
  assert.equal(bundle.kind, 'file'); assert.equal(launch.risky(bundle), true);
  assert.equal(launch.risky({ kind: 'file', id: '/qa/task.command' }), true);
  assert.equal(launch.risky({ kind: 'file', id: '/qa/readme.pdf' }), false);
});
test('macOS file search uses bounded folders without starting Windows Search', async () => {
  const files = load('files.js', 'darwin', {
    'node:path': path.posix,
    electron: { app: { getPath: (key) => `/qa/${key}` }, shell: {} },
    './apps': { powershell() { throw new Error('Windows Search must not run'); } },
    'node:fs': {
      promises: { opendir: async (dir) => dir === '/qa/documents' ? [{ name: 'report.pdf', isDirectory: () => false }] : [] },
      statSync: () => ({ mtimeMs: 7 }),
    },
  });
  const result = await files.search({ query: 'report', exts: ['pdf'] });
  assert.equal(result[0].path, '/qa/documents/report.pdf');
});
test('folder search streams real directories and excludes hidden/dependency trees', async (t) => {
  // Windows' system temp folder is under AppData, which search deliberately excludes.
  const root = fs.mkdtempSync(path.join(__dirname, 'capri-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ['documents', 'documents/nested', 'documents/.hidden', 'documents/node_modules']) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  }
  for (const file of ['documents/nested/report.pdf', 'documents/.hidden/report.pdf', 'documents/node_modules/report.pdf']) {
    fs.writeFileSync(path.join(root, file), 'QA');
  }
  const files = load('files.js', 'darwin', {
    electron: { app: { getPath: (key) => path.join(root, key) }, shell: {} }, './apps': {},
  });
  const results = await files.search({ query: 'report', exts: ['pdf'] });
  assert.deepEqual(results.map((r) => r.path), [path.join(root, 'documents/nested/report.pdf')]);
});
test('large folder searches yield and stop at the entry budget, closing the iterator', async () => {
  let visited = 0; let opened = 0; let closed = 0; let yieldedAt = 0;
  const tick = new Promise((resolve) => setImmediate(() => { yieldedAt = visited; resolve(); }));
  const files = load('files.js', 'darwin', {
    'node:path': path.posix,
    electron: { app: { getPath: (key) => `/qa/${key}` }, shell: {} }, './apps': {},
    'node:fs': {
      promises: { opendir: async () => {
        opened++;
        return (async function* () {
          try {
            for (let i = 0; i < 50000; i++) {
              visited++;
              yield { name: i === 40000 ? 'report.pdf' : `other-${i}.pdf`, isDirectory: () => false };
            }
          } finally { closed++; }
        })();
      } },
      statSync() { throw new Error('out-of-budget match must not be returned'); },
    },
  });
  assert.deepEqual(await files.search({ query: 'report' }), []);
  await tick;
  assert.ok(yieldedAt > 0 && yieldedAt < 40000, `event loop yielded at ${yieldedAt}`);
  assert.ok(visited <= 40001); // iterator may read the next entry before the loop checks its budget
  assert.equal(opened, 1); assert.equal(closed, 1);
});
test('folder searches stop collecting after enough matches and skip unreadable roots', async () => {
  let visited = 0; let closed = 0; let opened = 0;
  const files = load('files.js', 'darwin', {
    'node:path': path.posix,
    electron: { app: { getPath: (key) => `/qa/${key}` }, shell: {} }, './apps': {},
    'node:fs': {
      promises: { opendir: async (dir) => {
        opened++;
        if (dir === '/qa/desktop') throw new Error('permission denied');
        return (async function* () {
          try {
            for (let i = 0; i < 100; i++) {
              visited++;
              yield { name: `report-${i}.pdf`, isDirectory: () => false };
            }
          } finally { closed++; }
        })();
      } }, statSync: () => ({ mtimeMs: 7 }),
    },
  });
  const results = await files.search({ query: 'report' });
  assert.equal(results.length, 8);
  assert.ok(results.every((r) => r.path.startsWith('/qa/documents/')));
  assert.ok(visited <= 25); assert.equal(opened, 2); assert.equal(closed, 1);
});
test('successful Windows Search results bypass the folder walk', async () => {
  let indexed = 0;
  const files = load('files.js', 'win32', {
    'node:path': path.win32,
    electron: { app: { getPath: () => 'C:\\Users\\QA' }, shell: {} },
    './apps': { powershell: async () => { indexed++; return 'file:C:/Users/QA/Documents/report.pdf'; } },
    'node:fs': {
      promises: { opendir() { throw new Error('indexed results must not scan folders'); } },
      statSync: () => ({ mtimeMs: 7 }),
    },
  });
  const result = await files.search({ query: 'report' });
  assert.equal(result[0].path, 'C:\\Users\\QA\\Documents\\report.pdf');
  assert.equal(indexed, 1);
});
test('Windows launch and media still use their original AppsFolder and media-key routes', async () => {
  const calls = [];
  const launch = load('launch.js', 'win32', {
    electron: { shell: {} },
    './apps': { powershell: async (script) => { calls.push(script); return script.startsWith('Get-StartApps') ? '[{"Name":"QA App","AppID":"QA.App"}]' : ''; } },
    'node:child_process': {
      execFile(_file, _args, _opts, cb) { cb(new Error('no registry')); },
      spawn(file, args) { calls.push([file, args]); return { on() { return this; }, unref() {} }; },
    },
    'node:fs': { readdirSync() { return []; } },
  });
  await launch.launch({ kind: 'app', id: 'QA.App' });
  assert.deepEqual(calls[1], ['explorer.exe', ['shell:AppsFolder\\QA.App']]);
  assert.equal(await launch.media('pause'), true);
  assert.match(calls.at(-1), /179/);
});
test('macOS close revalidates app identity before invoking native termination', async () => {
  const calls = [];
  const apps = load('apps.js', 'darwin', {
    './macos': { run: async (...args) => { calls.push(args); return args[0] === 'apps' ? [{ name: 'QA', process: 'dev.capri.qa', label: 'QA', ids: [8] }] : { running: false }; } },
  });
  assert.deepEqual(await apps.close('not-listed'), { running: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(await apps.close('dev.capri.qa'), { running: false });
  assert.deepEqual(calls.at(-1), ['close', 'dev.capri.qa', 'normal']);
});
test('macOS Terminal launcher allowlists the integration and reports Automation denial', async () => {
  const calls = [];
  const setup = load('setup.js', 'darwin', {
    electron: { safeStorage: {} }, './ollama': {}, 'node:fs': { existsSync: () => false },
    'node:child_process': { execFile(file, args, _options, done) { calls.push([file, args]); done(new Error('Automation denied')); } },
  });
  assert.deepEqual(setup.launchThroughOllama('codex; touch /tmp/no'), { ok: false });
  const result = await setup.launchThroughOllama('codex');
  assert.equal(result.ok, false); assert.match(result.error, /Automation denied/);
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.equal(calls[0][1].at(-1), "'ollama' launch codex");
  assert.equal((await setup.installOllama()).ok, false);
});
test('Windows Ollama launcher retains cmd.exe start and rejects unsupported integrations', () => {
  let call;
  const setup = load('setup.js', 'win32', {
    electron: { safeStorage: {} }, './ollama': {}, 'node:fs': { existsSync: () => false },
    'node:child_process': { spawn(file, args, opts) { call = { file, args, opts }; return { on() { return this; }, unref() {} }; } },
  });
  assert.deepEqual(setup.launchThroughOllama('codex'), { ok: true });
  assert.equal(call.file, 'cmd.exe'); assert.equal(call.args[2], 'start');
  assert.equal(call.opts.windowsVerbatimArguments, true);
  assert.deepEqual(setup.launchThroughOllama('unknown'), { ok: false });
});

test('packaged macOS Codex hooks use the bundled runtime even without Node on PATH', () => {
  const hooks = load('../../scripts/install-codex-hooks.js', 'darwin', {}, {}, {
    versions: { electron: '44' }, execPath: "/Applications/QA's Capri.app/Contents/MacOS/Capri",
  });
  const command = hooks.hookCommand();
  assert.match(command, /^ELECTRON_RUN_AS_NODE=1 /);
  assert.match(command, /QA'"'"'s Capri/);
  assert.match(command, /capri-codex-hook\.js'$/);
});

function rivalClose({ snapshot, script, focus, keyed }) {
  const calls = [];
  const prompts = [];
  const mac = load('macos.js', 'darwin', {
    electron: {
      app: { isPackaged: false },
      systemPreferences: { isTrustedAccessibilityClient(on) { prompts.push(on); } },
    },
    'node:child_process': {
      spawn() { throw new Error('watch not used'); },
      execFile(file, args, opts, done) {
        const cb = typeof opts === 'function' ? opts : done;
        calls.push({ file: String(file), args: [...args] });
        if (String(file).endsWith('osascript')) script(args[1], cb);
        else if (args[0] === 'snapshot') cb(null, JSON.stringify(snapshot()));
        else if (args[0] === 'focus') cb(null, JSON.stringify(focus()));
        else if (args[0] === 'close-tab') cb(null, JSON.stringify(keyed ? keyed() : { ok: false, why: 'access' }));
        else cb(new Error(`unexpected ${args[0]}`));
      },
    },
  });
  const watch = mac.startWindowWatch({ overlay: {
    isDestroyed: () => true, getMediaSourceId: () => 'window:1:0',
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
  }, onUpdate() {} });
  const scripts = () => calls.filter((call) => call.file.endsWith('osascript')).map((call) => call.args[1]);
  return { calls, prompts, scripts, watch };
}
const win = (id, pid) => ({ id, pid, x: 0, y: 0, w: 800, h: 600, max: false });

test('macOS closes a rival tab by bringing that browser forward', async () => {
  let phase = 'other';
  const harness = rivalClose({
    snapshot: () => {
      if (phase === 'gone') return { fg: 9, frontPid: 42, trusted: true, title: 'New Tab - Google Chrome', bundle: 'com.google.Chrome', wins: [win(9, 42)] };
      if (phase === 'browser') return { fg: 9, frontPid: 42, trusted: true, title: 'ChatGPT - Google Chrome', bundle: 'com.google.Chrome', wins: [win(9, 42), win(1, 7)] };
      return { fg: 1, frontPid: 7, trusted: true, title: 'Capri', bundle: 'app.capri', wins: [win(9, 42), win(1, 7)] };
    },
    focus: () => {
      if (phase === 'other') phase = 'browser';
      return { ok: true, trusted: true, held: false };
    },
    script(text, cb) {
      assert.match(text, /tell application "Google Chrome"/);
      assert.match(text, /close active tab of front window/);
      assert.doesNotMatch(text, /shift down|option down|control down/);
      phase = 'gone';
      cb(null, '');
    },
  });
  assert.equal(await harness.watch.close(9, 'chatgpt'), '');
  assert.equal(harness.scripts().length, 1);
  assert.equal(harness.calls.some((call) => call.args[0] === 'close-tab'), false);
  const focusAt = harness.calls.findIndex((call) => call.args[0] === 'focus');
  const scriptAt = harness.calls.findIndex((call) => call.file.endsWith('osascript'));
  assert.ok(focusAt >= 0 && focusAt < scriptAt);
  assert.deepEqual(harness.calls[focusAt].args, ['focus', '42']);
  assert.equal(harness.prompts.length, 0);
  harness.watch.stop();
});

test('Safari uses its dictionary and Firefox gets Command-W with no extra modifiers', async () => {
  for (const [bundle, title, app, expectScript] of [
    ['com.apple.Safari', 'ChatGPT - Safari', 'Safari', /close current tab of front window/],
    ['org.mozilla.firefox', 'ChatGPT - Firefox', 'Firefox', /keystroke "w" using command down/],
  ]) {
    let gone = false;
    const harness = rivalClose({
      snapshot: () => ({
        fg: 9, frontPid: 42, trusted: true, bundle,
        title: gone ? `New Tab - ${app}` : title, wins: [win(9, 42)],
      }),
      focus: () => ({ ok: true, trusted: true, held: false }),
      script(text, cb) {
        assert.match(text, expectScript);
        assert.match(text, new RegExp(app));
        assert.doesNotMatch(text, /shift down|option down|control down/);
        gone = true;
        cb(null, '');
      },
    });
    assert.equal(await harness.watch.close(9, 'chatgpt'), '');
    assert.equal(harness.calls.some((call) => call.args[0] === 'close-tab'), false);
    if (bundle.includes('firefox')) assert.equal(harness.scripts().some((text) => /close active tab|close current tab/.test(text)), false);
    harness.watch.stop();
  }
});

test('the last rival tab counts as closed once its window is gone', async () => {
  let closed = false;
  const harness = rivalClose({
    snapshot: () => ({
      fg: closed ? 1 : 9, frontPid: closed ? 7 : 42, trusted: true,
      title: closed ? 'Capri' : 'ChatGPT - Google Chrome',
      bundle: closed ? 'app.capri' : 'com.google.Chrome',
      wins: closed ? [win(1, 7)] : [win(9, 42)],
    }),
    focus: () => ({ ok: true, trusted: true, held: false }),
    script(_text, cb) { closed = true; cb(null, ''); },
  });
  assert.equal(await harness.watch.close(9, 'chatgpt'), '');
  assert.equal(harness.calls.some((call) => call.args[0] === 'close-tab'), false);
  harness.watch.stop();
});

test('System Events can name the front page when the helper is not trusted', async () => {
  let gone = false;
  const harness = rivalClose({
    snapshot: () => ({ fg: 9, frontPid: 42, trusted: false, wins: [win(9, 42)] }),
    focus: () => ({ ok: true, trusted: false, held: false }),
    script(text, cb) {
      if (text.includes('bundle identifier')) {
        cb(null, `${gone ? 'com.google.Chrome\nNew Tab - Google Chrome' : 'com.google.Chrome\nChatGPT - Google Chrome'}\n`);
        return;
      }
      assert.match(text, /close active tab of front window/);
      assert.doesNotMatch(text, /shift down|option down|control down/);
      gone = true;
      cb(null, '');
    },
  });
  assert.equal(await harness.watch.close(9, 'chatgpt'), '');
  assert.equal(harness.calls.some((call) => call.args[0] === 'close-tab'), false);
  assert.equal(harness.prompts.length, 0);
  harness.watch.stop();
});

test('a held Shift, Option, or Control key blocks the tab close', async () => {
  const harness = rivalClose({
    snapshot: () => ({
      fg: 9, frontPid: 42, trusted: true, title: 'ChatGPT - Google Chrome', bundle: 'com.google.Chrome', wins: [win(9, 42)],
    }),
    focus: () => ({ ok: true, trusted: true, held: true }),
    script(_text, cb) { cb(new Error('script should not run')); },
  });
  assert.equal(await harness.watch.close(9, 'chatgpt'), 'keys');
  assert.equal(harness.scripts().length, 0);
  assert.equal(harness.calls.some((call) => call.args[0] === 'close-tab'), false);
  harness.watch.stop();
});

test('missing permission is reported and a refused browser command falls back to the keystroke', async () => {
  const denied = rivalClose({
    snapshot: () => ({ fg: 9, frontPid: 42, trusted: false, wins: [win(9, 42)] }),
    focus: () => ({ ok: true, trusted: false, held: false }),
    script(text, cb) {
      assert.match(text, /bundle identifier/);
      const err = new Error('Not authorized to send Apple events to System Events. (-1743)');
      cb(err, '', err.message);
    },
  });
  assert.equal(await denied.watch.close(9, 'chatgpt'), 'access');
  assert.deepEqual(denied.prompts, [true]);
  assert.equal(denied.scripts().some((text) => /keystroke|close active tab/.test(text)), false);
  denied.watch.stop();

  let gone = false;
  let shots = 0;
  const fallback = rivalClose({
    snapshot: () => ({
      fg: 9, frontPid: 42, trusted: true, bundle: 'com.google.Chrome', wins: [win(9, 42)],
      title: gone ? 'New Tab - Google Chrome' : 'ChatGPT - Google Chrome',
    }),
    focus: () => ({ ok: true, trusted: true, held: false }),
    script(text, cb) {
      shots += 1;
      if (text.includes('close active tab')) {
        const err = new Error('Not authorized to send Apple events to Google Chrome. (-1743)');
        cb(err, '', err.message);
        return;
      }
      assert.match(text, /keystroke "w" using command down/);
      assert.doesNotMatch(text, /shift down|option down|control down/);
      gone = true;
      cb(null, '');
    },
  });
  assert.equal(await fallback.watch.close(9, 'chatgpt'), '');
  assert.ok(shots >= 2);
  assert.equal(fallback.calls.some((call) => call.args[0] === 'close-tab'), false);
  assert.equal(fallback.prompts.length, 0);
  fallback.watch.stop();
});

test('she does not claim a tab closed while that page is still in front', async () => {
  const harness = rivalClose({
    snapshot: () => ({
      fg: 9, frontPid: 42, trusted: true, title: 'ChatGPT - Google Chrome', bundle: 'com.google.Chrome', wins: [win(9, 42)],
    }),
    focus: () => ({ ok: true, trusted: true, held: false }),
    script(_text, cb) { cb(null, ''); },
    keyed: () => ({ ok: false, why: 'front' }),
  });
  assert.equal(await harness.watch.close(9, 'chatgpt'), 'late');
  assert.equal(harness.scripts().length, 1);
  assert.doesNotMatch(harness.scripts()[0], /keystroke/);
  assert.equal(harness.prompts.length, 0);
  harness.watch.stop();
});

test('a missing macOS permission is said out loud when a rival tab stays open', async (t) => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const timers = [];
  const realInterval = global.setInterval;
  global.setInterval = (fn, ms) => { const id = realInterval(fn, ms); timers.push(id); return id; };
  t.after(() => {
    for (const id of timers) clearInterval(id);
    global.setInterval = realInterval;
    delete globalThis.localStorage;
    delete globalThis.matchMedia;
  });
  const { Jealousy } = await import(browserModule(path.resolve(__dirname, '../src/renderer/js/bond.js')));
  const said = [];
  const jealousy = new Jealousy({
    capri: { windows: { wins: [{ id: 9 }] }, jealous: async () => true, zapShut: async (_win, onHit) => onHit() },
    panel: { say: (line) => said.push(line), hide: () => said.push('hide') },
    brain: { t: { jealous: { close: ['Closing {rival}.'], download: ['No {rival}.'], spared: ['Fine.'], spare: 'Let me', closed: ['Closed.'], blocked: 'NEED ACCESS' } } },
    bond: { stage: 1, feel() {} }, chat: {}, guide: {}, host: {},
  });
  for (const id of timers) clearInterval(id);
  jealousy.warn = async () => false;
  jealousy.front = { id: 9, key: 'chatgpt', page: 'site' };
  jealousy.shut = async () => 'access';
  assert.equal(await jealousy.chase({ key: 'chatgpt', id: 9, page: 'site' }, { id: 9 }), 'access');
  assert.equal(said.some((line) => line === 'hide'), false);
  assert.equal(said.at(-1).line, 'NEED ACCESS');
  assert.equal(said.at(-1).face, 'aside');
});
