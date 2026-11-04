'use strict';

// The same front-window check as windows.ps1: which other AIs the title names, which of those
// are that AI's own browser page, and whether the page is a download. The title stays in the
// main process. Callers send only these flags onward.

const SEP = String.raw`(?: [-|:\u2013\u2014] |: |(?: \p{L}{1,5}){1,2} \d+ (?=.*Edge$))`;
const DL = /download|t.l.charg|desc.rg|baix(?:ar|e|a|ando)|transf(?:erir|ira|ere)|herunterlad|scaric|install|setup|\u0441\u043a\u0430\u0447|\u0437\u0430\u0433\u0440\u0443\u0437|\u0443\u0441\u0442\u0430\u043d\u043e\u0432/i;

const AIS = [
  ['chatgpt', /\bChatGPT\b/i, 'chatgpt', 'ChatGPT'],
  ['claude', /\bClaude\b/i, 'claude', 'Claude'],
  ['codex', /\bCodex\b/i, 'codex', 'Codex'],
  ['gemini', /\bGemini\b/i, '', '(?:Google )?Gemini'],
  ['copilot', /\bCopilot\b/i, 'copilot', '(?:Microsoft )?Copilot'],
  ['perplexity', /\bPerplexity\b/i, 'perplexity', 'Perplexity'],
  ['deepseek', /\bDeepSeek\b/i, '', 'DeepSeek'],
  ['grok', /\bGrok\b/i, '', 'Grok'],
  ['lechat', /\bLe Chat\b|\bMistral AI\b/i, '', 'Le Chat|Mistral AI'],
  ['characterai', /character\.ai/i, '', 'character\\.ai'],
  ['metaai', /\bMeta AI\b/i, '', 'Meta AI'],
];

const BROWSERS = new Set([
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'chromium', 'librewolf', 'waterfox', 'floorp', 'zen', 'thorium', 'safari',
]);

// bundle -> [process key, System Events process name, AppleScript tab noun or '' when it has none]
const MAC_BROWSER = {
  'com.google.chrome': ['chrome', 'Google Chrome', 'active tab'],
  'com.google.chrome.canary': ['chrome', 'Google Chrome Canary', 'active tab'],
  'com.apple.safari': ['safari', 'Safari', 'current tab'],
  'com.apple.safari.technologypreview': ['safari', 'Safari Technology Preview', 'current tab'],
  'org.mozilla.firefox': ['firefox', 'Firefox', ''],
  'org.mozilla.nightly': ['firefox', 'Firefox Nightly', ''],
  'com.microsoft.edgemac': ['msedge', 'Microsoft Edge', 'active tab'],
  'com.microsoft.edgemac.beta': ['msedge', 'Microsoft Edge Beta', 'active tab'],
  'com.brave.browser': ['brave', 'Brave Browser', 'active tab'],
  'company.thebrowser.browser': ['arc', 'Arc', 'active tab'],
  'com.operasoftware.opera': ['opera', 'Opera', 'active tab'],
  'com.vivaldi.vivaldi': ['vivaldi', 'Vivaldi', 'active tab'],
  'org.chromium.chromium': ['chromium', 'Chromium', 'active tab'],
  'org.mozilla.librewolf': ['librewolf', 'LibreWolf', ''],
  'app.zen-browser.zen': ['zen', 'Zen', ''],
  'org.mozilla.floorp': ['floorp', 'Floorp', ''],
  'net.waterfox.waterfox': ['waterfox', 'Waterfox', ''],
};

const site = (pattern) => new RegExp(`(?:^|${SEP})(?:${pattern})(?:${SEP}|$)`, 'i');

function processName(snap) {
  if (snap.proc) return String(snap.proc).toLowerCase();
  const row = MAC_BROWSER[String(snap.bundle || '').toLowerCase()];
  return row ? row[0] : '';
}

// How to close the front tab of this browser. `tab` is the AppleScript noun ("active tab" or
// "current tab"); browsers without a dictionary get a Command-W keystroke to `app` instead.
function browserControl(bundle) {
  const row = MAC_BROWSER[String(bundle || '').toLowerCase()];
  if (!row) return null;
  return { app: row[1], tab: row[2] || null };
}

function browser(snap, proc) {
  return BROWSERS.has(proc) || Boolean(MAC_BROWSER[String(snap.bundle || '').toLowerCase()]);
}

function classify(snap = {}) {
  const title = String(snap.title || '');
  const proc = processName(snap);
  const inBrowser = browser(snap, proc);
  const ai = [];
  const pages = [];
  for (const [key, titleRe, ownProc, sitePattern] of AIS) {
    if (!titleRe.test(title) && !(ownProc && proc === ownProc)) continue;
    ai.push(key);
    if (inBrowser && site(sitePattern).test(title)) pages.push(key);
  }
  return { ai, pages, dl: inBrowser && ai.length > 0 && DL.test(title) };
}

function isBrowser(snap = {}) {
  return browser(snap, processName(snap));
}

module.exports = { classify, isBrowser, browserControl };
