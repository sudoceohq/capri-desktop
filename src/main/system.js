'use strict';

// What her chat can do to the computer itself: open one of its settings, say what's left of
// its battery's charge, disk and memory and what its IP is, set its sound, start a snip, get its
// windows out of the way or side by side, switch it dark or light, and lock it, put it to sleep,
// shut it down or restart it (those only after your click in her chat).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { shell, screen } = require('electron');
const apps = require('./apps');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const POWER_PID = path.join(os.tmpdir(), 'capri-power.pid');

// her words for them -> Windows' own settings pages (ms-settings:)
const SETTINGS = {
  bluetooth: 'bluetooth', sound: 'sound', wifi: 'network-wifi', network: 'network-status', update: 'windowsupdate',
  display: 'display', notifications: 'notifications', mouse: 'mousetouchpad', power: 'powersleep',
  battery: 'batterysaver', background: 'personalization-background', storage: 'storagesense',
};

// macOS 13 System Settings panes. Same keys as SETTINGS.
const MAC_SETTINGS = {
  bluetooth: 'x-apple.systempreferences:com.apple.BluetoothSettings',
  sound: 'x-apple.systempreferences:com.apple.Sound-Settings.extension',
  wifi: 'x-apple.systempreferences:com.apple.wifi-settings-extension',
  network: 'x-apple.systempreferences:com.apple.Network-Settings.extension',
  update: 'x-apple.systempreferences:com.apple.Software-Update-Settings.extension',
  display: 'x-apple.systempreferences:com.apple.Displays-Settings.extension',
  notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  mouse: 'x-apple.systempreferences:com.apple.Mouse-Settings.extension',
  power: 'x-apple.systempreferences:com.apple.Battery-Settings.extension',
  battery: 'x-apple.systempreferences:com.apple.Battery-Settings.extension',
  background: 'x-apple.systempreferences:com.apple.Wallpaper-Settings.extension',
  storage: 'x-apple.systempreferences:com.apple.settings.Storage',
};

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 15000 }, (err) => resolve(!err));
});

const osaResult = (script) => new Promise((resolve) => {
  execFile('/usr/bin/osascript', ['-e', script], { timeout: 20000 }, (err, out, errText) => {
    if (!err) return resolve({ ok: true, out: String(out ?? ''), denied: false });
    const why = `${err.message || ''} ${errText || ''}`;
    // System Events refuses the call until Accessibility is granted. -1743 is the Automation denial.
    resolve({ ok: false, out: '', denied: /assistive|not allowed|not authorized|-1719|-1743|-1002/i.test(why) });
  });
});

const osa = async (script) => {
  const result = await osaResult(script);
  return result.ok ? result.out : null;
};

const quoted = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

async function settings(page) {
  if (MAC) {
    if (!MAC_SETTINGS[page]) return false;
    await shell.openExternal(MAC_SETTINGS[page]);
    return true;
  }
  if (!WIN || !SETTINGS[page]) return false;
  await shell.openExternal(`ms-settings:${SETTINGS[page]}`);
  return true;
}

// Its battery (none on a desktop), the disk Windows is on, the memory, and the PC's address on
// your network (not the internet's idea of it: that would mean asking a website).
async function info(what) {
  if (what === 'battery') {
    if (MAC) {
      const out = await new Promise((resolve) => {
        execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5000 }, (err, text) => resolve(err ? '' : String(text || '')));
      });
      const line = out.split('\n').find((row) => row.includes('%'));
      if (!line) return { none: true };
      const percent = Number(line.match(/(\d+)%/)[1]);
      const charging = /discharging/i.test(line) ? false : /charg/i.test(line);
      return { percent, charging };
    }
    const out = WIN && await apps.powershell('Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json -Compress').catch(() => '');
    if (!out) return { none: true };
    const b = JSON.parse(out);
    // BatteryStatus: 1 on battery; 2 on the charger; 3 full; 6 to 9 charging
    return { percent: b.EstimatedChargeRemaining, charging: [2, 3, 6, 7, 8, 9].includes(b.BatteryStatus) };
  }
  if (what === 'disk') {
    const drive = WIN ? `${process.env.SystemDrive || 'C:'}\\` : '/';
    try {
      const s = fs.statfsSync(drive);
      return { drive: drive.slice(0, 2), free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      return null;
    }
  }
  if (what === 'ram') return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
  if (what === 'ip') {
    const local = Object.entries(os.networkInterfaces())
      .filter(([name]) => !/virtual|vethernet|vmware|loopback|vbox|wsl|hyper-v/i.test(name))
      .flatMap(([, list]) => list || [])
      .find((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
    return { ip: local?.address || null };
  }
  if (what === 'bluetooth' && MAC) return { devices: await bluetoothDevices() };
  return null;
}

// Read-only. blueutil when the user has it, otherwise the system report.
function bluetoothNames(text) {
  const named = [...String(text).matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
  if (named.length) return named;
  try {
    const names = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      for (const [key, value] of Object.entries(node)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { walk(value); continue; }
        const flag = value.device_isconnected || value.device_connected || value.Connected;
        if (flag === 'attrib_Yes' || flag === 'Yes' || flag === true) names.push(key);
        else walk(value);
      }
    };
    walk(JSON.parse(text));
    if (names.length) return names;
  } catch { /* the text report, below */ }
  const found = [];
  let device = '';
  let deviceIndent = -1;
  let list = false;
  let listIndent = -1;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();
    if (/^Not Connected:$/i.test(trimmed)) { list = false; device = ''; continue; }
    if (/^Connected:$/i.test(trimmed)) { list = true; listIndent = indent; device = ''; continue; }
    const header = trimmed.match(/^(.+):$/)?.[1];
    if (header) {
      if (list && indent > listIndent) found.push(header);
      else { device = header; deviceIndent = indent; }
      continue;
    }
    if (device && indent > deviceIndent && /^Connected:\s*(?:Yes|attrib_Yes|true)\b/i.test(trimmed)) found.push(device);
  }
  return found;
}

function commandOut(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out || '')));
  });
}

async function bluetoothDevices() {
  const bins = ['/opt/homebrew/bin/blueutil', '/usr/local/bin/blueutil'];
  for (const bin of bins) {
    if (!fs.existsSync(bin)) continue;
    const out = await commandOut(bin, ['--connected']);
    if (out != null) return bluetoothNames(out);
  }
  const out = await commandOut('/usr/sbin/system_profiler', ['SPBluetoothDataType', '-json']);
  return out == null ? [] : bluetoothNames(out);
}

// Windows' own volume (the default speakers), through its Core Audio interfaces.
const AUDIO = `Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid context);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid context);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, int p, out IAudioEndpointVolume volume); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator { }
public static class CapriAudio {
  static IAudioEndpointVolume Volume() {
    IMMDevice device;
    Marshal.ThrowExceptionForHR(((IMMDeviceEnumerator)new DeviceEnumerator()).GetDefaultAudioEndpoint(0, 1, out device));
    IAudioEndpointVolume volume;
    var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(device.Activate(ref id, 23, 0, out volume));
    return volume;
  }
  public static int Level { get { float v; Marshal.ThrowExceptionForHR(Volume().GetMasterVolumeLevelScalar(out v)); return (int)Math.Round(v * 100); } }
  public static void Set(int level) { Marshal.ThrowExceptionForHR(Volume().SetMasterVolumeLevelScalar(level / 100f, Guid.Empty)); }
  public static void Mute(bool mute) { Marshal.ThrowExceptionForHR(Volume().SetMute(mute, Guid.Empty)); }
}
"@
`;

// { level } (0 to 100, unmuted too), { mute: true | false }, or neither: the level now
async function volume({ level = null, mute = null, delta = null } = {}) {
  if (MAC) {
    if (Number.isFinite(level)) {
      const n = Math.round(Math.min(100, Math.max(0, level)));
      const out = await osa(`set volume output volume ${n} without muting`);
      if (out == null) return null;
    } else if (Number.isFinite(delta)) {
      const step = Math.round(Math.min(100, Math.max(-100, delta)));
      const out = await osa(`set currentLevel to output volume of (get volume settings)
set nextLevel to currentLevel + (${step})
if nextLevel > 100 then set nextLevel to 100
if nextLevel < 0 then set nextLevel to 0
set volume output volume nextLevel without muting`);
      if (out == null) return null;
    } else if (typeof mute === 'boolean') {
      const out = await osa(`set volume ${mute ? 'with' : 'without'} output muted`);
      if (out == null) return null;
    }
    const out = await osa('output volume of (get volume settings)');
    const now = Number.parseInt(out, 10);
    return Number.isFinite(now) ? { level: now } : null;
  }
  if (!WIN) return null;
  let line = '';
  if (Number.isFinite(level)) line = `[CapriAudio]::Set(${Math.round(Math.min(100, Math.max(0, level)))}); [CapriAudio]::Mute($false); `;
  else if (typeof mute === 'boolean') line = `[CapriAudio]::Mute($${mute}); `;
  const out = await apps.powershell(`${AUDIO}${line}[CapriAudio]::Level`).catch(() => null);
  const now = Number.parseInt(out, 10);
  return Number.isFinite(now) ? { level: now } : null;
}

// Windows' own snip: you pick the area, it lands in your clipboard.
async function snip() {
  if (MAC) {
    const child = spawn('/usr/sbin/screencapture', ['-i', '-c'], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }
  if (!WIN) return false;
  await shell.openExternal('ms-screenclip:');
  return true;
}

// Every window down to the taskbar (your desktop shows), or back up.
async function tidy(back = false) {
  if (MAC) {
    const script = back
      ? 'tell application "System Events" to set visible of every process to true'
      : 'tell application "System Events" to set visible of every process whose visible is true and name is not "Finder" and name is not "Capri" to false';
    const result = await osaResult(script);
    if (result.denied) return { denied: true };
    return result.ok;
  }
  if (!WIN) return false;
  return apps.powershell(`(New-Object -ComObject Shell.Application).${back ? 'UndoMinimizeALL' : 'MinimizeAll'}()`).then(() => true, () => false);
}

// The window of app `name` on the left or right half of the screen she's on (its frame's
// invisible edges taken into account, so it fills it).
async function arrange(name, side, display) {
  if (MAC) {
    if (!['left', 'right'].includes(side) || !display?.workArea) return null;
    const app = await apps.find(name).catch(() => null);
    if (!app) return { found: false };
    const work = display.workArea;
    const half = Math.floor(work.width / 2);
    const x = side === 'left' ? work.x : work.x + half;
    const script = `tell application "System Events" to tell process "${quoted(app.label || app.name)}"
      set position of window 1 to {${Math.round(x)}, ${Math.round(work.y)}}
      set size of window 1 to {${half}, ${Math.round(work.height)}}
    end tell`;
    const result = await osaResult(script);
    if (result.denied) return { found: false, denied: true, name: app.name };
    return { found: result.ok, name: app.name };
  }
  if (!WIN || !['left', 'right'].includes(side)) return null;
  const app = await apps.find(name).catch(() => null);
  if (!app?.ids?.length) return { found: false };
  const work = screen.dipToScreenRect(null, display.workArea);
  const edge = Math.round(7 * display.scaleFactor);
  const half = Math.floor(work.width / 2);
  const x = (side === 'left' ? work.x : work.x + half) - edge;
  const out = await apps.powershell(
    'Add-Type -Namespace Capri -Name Place -MemberDefinition \''
    + '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); '
    + '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); '
    + '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);\'; '
    + '[void][Capri.Place]::SetProcessDpiAwarenessContext([IntPtr](-4)); '
    + `$h = (Get-Process -Id ${app.ids.join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle; `
    + 'if (-not $h) { "none"; exit }; '
    + '[void][Capri.Place]::ShowWindow($h, 9); '
    + `[void][Capri.Place]::SetWindowPos($h, [IntPtr]::Zero, ${x}, ${work.y}, ${half + edge * 2}, ${work.height + edge}, 0x0040); "ok"`,
  ).catch(() => '');
  return { found: out.trim() === 'ok', name: app.name };
}

// Windows and its apps dark or light, told to everything open so it changes right away.
async function theme(dark) {
  if (MAC) {
    const out = await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${dark ? 'true' : 'false'}`);
    return out != null;
  }
  if (!WIN) return false;
  const v = dark ? 0 : 1;
  return apps.powershell(
    '$k = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"; '
    + `Set-ItemProperty -Path $k -Name AppsUseLightTheme -Value ${v} -Type DWord; `
    + `Set-ItemProperty -Path $k -Name SystemUsesLightTheme -Value ${v} -Type DWord; `
    + 'Add-Type -Namespace Capri -Name Msg -MemberDefinition \'[DllImport("user32.dll", CharSet = CharSet.Unicode)] '
    + 'public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);\'; '
    + '$r = [UIntPtr]::Zero; [void][Capri.Msg]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "ImmersiveColorSet", 2, 3000, [ref]$r)',
  ).then(() => true, () => false);
}

// Lock, sleep, or shut down / restart in `seconds` (Windows' own countdown: 'cancel' stops it).
function cancelMacPower() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(POWER_PID, 'utf8')); } catch { return false; }
  try { process.kill(pid); } catch { return false; }
  fs.rmSync(POWER_PID, { force: true });
  return true;
}

function scheduleMacPower(action, seconds) {
  cancelMacPower();
  const verb = action === 'restart' ? 'restart' : 'shut down';
  const delay = Math.round(Math.min(315360000, Math.max(0, seconds)));
  const child = spawn('/usr/bin/osascript', ['-e', `delay ${delay}\ntell application "System Events" to ${verb}`], {
    detached: true, stdio: 'ignore',
  });
  if (!child.pid) return false;
  fs.writeFileSync(POWER_PID, String(child.pid));
  child.unref();
  return true;
}

async function power(action, seconds = 60) {
  if (MAC) {
    if (action === 'lock') return (await osa('tell application "System Events" to keystroke "q" using {command down, control down}')) != null;
    if (action === 'sleep') return run('/usr/bin/pmset', ['sleepnow']);
    if (action === 'shutdown' || action === 'restart') return scheduleMacPower(action, seconds);
    if (action === 'cancel') return cancelMacPower();
    return false;
  }
  if (!WIN) return false;
  const s = String(Math.round(Math.min(315360000, Math.max(0, seconds))));
  if (action === 'lock') return run('rundll32.exe', ['user32.dll,LockWorkStation']);
  if (action === 'sleep') {
    return apps.powershell('Add-Type -AssemblyName System.Windows.Forms; '
      + '[void][System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)').then(() => true, () => false);
  }
  if (action === 'shutdown') return run('shutdown.exe', ['/s', '/t', s]);
  if (action === 'restart') return run('shutdown.exe', ['/r', '/t', s]);
  if (action === 'cancel') return run('shutdown.exe', ['/a']);
  return false;
}

// One way in, from her chat (main.js): only these, with only what each takes.
function act(req = {}, { display } = {}) {
  switch (req.action) {
    case 'settings': return settings(String(req.page));
    case 'info': return info(String(req.what));
    case 'volume': return volume({
      level: Number.isFinite(req.level) ? req.level : null,
      mute: typeof req.mute === 'boolean' ? req.mute : null,
      delta: Number.isFinite(req.delta) ? req.delta : null,
    });
    case 'snip': return snip();
    case 'tidy': return tidy(Boolean(req.back));
    case 'arrange': return arrange(String(req.name || '').slice(0, 80), req.side, display);
    case 'theme': return theme(Boolean(req.dark));
    case 'power': return power(String(req.what), Number(req.seconds) || 0);
    default: return null;
  }
}

module.exports = { act, SETTINGS };
