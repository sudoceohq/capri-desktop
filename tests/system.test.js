'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function load(platform, mocks, extraProcess = {}) {
  const file = path.resolve(__dirname, '../src/main/system.js');
  const realRequire = createRequire(file);
  const localRequire = (id) => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id);
  const module = { exports: {} };
  const proc = { platform, env: {}, kill() {}, ...extraProcess };
  new Function('require', 'module', 'exports', '__dirname', 'process', fs.readFileSync(file, 'utf8'))(
    localRequire, module, module.exports, path.dirname(file), proc,
  );
  return module.exports;
}

const display = { workArea: { x: 10, y: 30, width: 1000, height: 700 }, scaleFactor: 2 };

test('macOS settings, volume, snip, theme, and sleep use system tools', async () => {
  const opened = [];
  const commands = [];
  const spawned = [];
  const system = load('darwin', {
    electron: { shell: { openExternal: async (url) => { opened.push(url); } }, screen: {} },
    './apps': { find: async () => null, powershell() { throw new Error('powershell'); } },
    'node:child_process': {
      execFile(file, args, _opts, done) {
        commands.push([file, args]);
        if (args[0] === '-g') done(null, 'Now drawing from Battery Power\n -InternalBattery-0 61%; discharging; 2:00 remaining\n');
        else if (String(args[1] || '').includes('output volume of')) done(null, '30\n');
        else done(null, '');
      },
      spawn(file, args) { spawned.push([file, args]); return { pid: 77, unref() {} }; },
    },
  });
  assert.equal(await system.act({ action: 'settings', page: 'bluetooth' }), true);
  assert.equal(opened[0], 'x-apple.systempreferences:com.apple.BluetoothSettings');
  assert.equal(await system.act({ action: 'settings', page: 'nope' }), false);
  assert.deepEqual(await system.act({ action: 'volume', level: 30 }), { level: 30 });
  assert.match(commands.find(([, args]) => args[0] === '-e')[1][1], /output volume 30/);
  assert.equal(await system.act({ action: 'snip' }), true);
  assert.deepEqual(spawned[0], ['/usr/sbin/screencapture', ['-i', '-c']]);
  assert.equal(await system.act({ action: 'theme', dark: true }), true);
  assert.match(commands.at(-1)[1][1], /dark mode to true/);
  assert.equal(await system.act({ action: 'power', what: 'sleep' }), true);
  assert.deepEqual(commands.at(-1), ['/usr/bin/pmset', ['sleepnow']]);
  assert.deepEqual(await system.act({ action: 'info', what: 'battery' }), { percent: 61, charging: false });
  const disk = await system.act({ action: 'info', what: 'disk' });
  assert.equal(disk.drive, '/');
  assert.equal(typeof disk.free, 'number');
});

test('macOS window arrange names the running app and tidy hides the others', async () => {
  const scripts = [];
  const system = load('darwin', {
    electron: { shell: { openExternal: async () => {} }, screen: {} },
    './apps': { find: async () => ({ name: 'TextEdit', label: 'TextEdit' }) },
    'node:child_process': {
      execFile(_file, args, _opts, done) { scripts.push(args[1]); done(null, ''); },
      spawn() { return { pid: 1, unref() {} }; },
    },
  });
  assert.deepEqual(await system.act({ action: 'arrange', name: 'TextEdit', side: 'right' }, { display }), {
    found: true, name: 'TextEdit',
  });
  assert.match(scripts[0], /process "TextEdit"/);
  assert.match(scripts[0], /\{510, 30\}/);
  assert.equal(await system.act({ action: 'tidy' }), true);
  assert.match(scripts[1], /name is not "Capri"/);
  assert.equal(await system.act({ action: 'arrange', name: 'Missing', side: 'up' }, { display }), null);
});

test('macOS volume up steps from the current level, and a denied arrange says so', async () => {
  const scripts = [];
  const system = load('darwin', {
    electron: { shell: {}, screen: {} },
    './apps': { find: async () => ({ name: 'TextEdit', label: 'TextEdit' }) },
    'node:child_process': {
      execFile(_file, args, _opts, done) {
        scripts.push(args[1]);
        if (String(args[1]).includes('process')) done(new Error('osascript is not allowed assistive access'));
        else if (args[1] === 'output volume of (get volume settings)') done(null, '46\n');
        else done(null, '');
      },
      spawn() { return { pid: 1, unref() {} }; },
    },
  });
  assert.deepEqual(await system.act({ action: 'volume', delta: 10 }), { level: 46 });
  assert.match(scripts[0], /currentLevel \+ \(10\)/);
  assert.deepEqual(await system.act({ action: 'arrange', name: 'TextEdit', side: 'left' }, { display }), {
    found: false, denied: true, name: 'TextEdit',
  });
  assert.deepEqual(await system.act({ action: 'tidy' }), { denied: true });
});

test('macOS Bluetooth status prefers blueutil and otherwise reads system_profiler', async () => {
  const blue = load('darwin', {
    electron: { shell: {}, screen: {} },
    './apps': {},
    'node:fs': { existsSync: (file) => String(file).endsWith('/opt/homebrew/bin/blueutil'), readFileSync() { throw new Error('no'); }, rmSync() {}, writeFileSync() {} },
    'node:child_process': {
      execFile(file, args, _opts, done) {
        assert.equal(file, '/opt/homebrew/bin/blueutil');
        assert.deepEqual(args, ['--connected']);
        done(null, 'address: aa-bb, name: "AirPods"\n');
      },
      spawn() { return { unref() {} }; },
    },
  });
  assert.deepEqual(await blue.act({ action: 'info', what: 'bluetooth' }), { devices: ['AirPods'] });
  const profile = load('darwin', {
    electron: { shell: {}, screen: {} },
    './apps': {},
    'node:fs': { existsSync: () => false, readFileSync() { throw new Error('no'); }, rmSync() {}, writeFileSync() {} },
    'node:child_process': {
      execFile(file, args, _opts, done) {
        assert.equal(file, '/usr/sbin/system_profiler');
        assert.deepEqual(args, ['SPBluetoothDataType', '-json']);
        done(null, JSON.stringify({ SPBluetoothDataType: [{ device_title: [{ Mouse: { device_isconnected: 'attrib_Yes' } }] }] }));
      },
      spawn() { return { unref() {} }; },
    },
  });
  assert.deepEqual(await profile.act({ action: 'info', what: 'bluetooth' }), { devices: ['Mouse'] });
});

test('macOS shutdown can be cancelled before it runs', async () => {
  const killed = [];
  let spawned;
  const system = load('darwin', {
    electron: { shell: {}, screen: {} },
    './apps': {},
    'node:child_process': {
      execFile(_file, _args, _opts, done) { done(null, ''); },
      spawn(_file, args) { spawned = args; return { pid: 4242, unref() {} }; },
    },
  }, { kill(pid) { killed.push(pid); } });
  assert.equal(await system.act({ action: 'power', what: 'shutdown', seconds: 5 }), true);
  assert.match(spawned[1], /delay 5/);
  assert.match(spawned[1], /shut down/);
  assert.equal(await system.act({ action: 'power', what: 'cancel' }), true);
  assert.deepEqual(killed, [4242]);
});

test('Windows settings stay on ms-settings and volume stays on PowerShell', async () => {
  const opened = [];
  let asked = '';
  const system = load('win32', {
    electron: { shell: { openExternal: async (url) => { opened.push(url); } }, screen: {} },
    './apps': { powershell: async (script) => { asked = script; return '40'; } },
    'node:child_process': { execFile() {}, spawn() { return { unref() {} }; } },
  });
  assert.equal(await system.act({ action: 'settings', page: 'sound' }), true);
  assert.equal(opened[0], 'ms-settings:sound');
  assert.deepEqual(await system.act({ action: 'volume' }), { level: 40 });
  assert.match(asked, /CapriAudio/);
});
