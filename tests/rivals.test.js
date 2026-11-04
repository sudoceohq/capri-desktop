'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, browserControl } = require('../src/main/rivals');

test('a browser tab that is the AI itself counts as its page', () => {
  const flags = classify({ title: 'ChatGPT - Google Chrome', bundle: 'com.google.Chrome' });
  assert.deepEqual(flags.ai, ['chatgpt']);
  assert.deepEqual(flags.pages, ['chatgpt']);
  assert.equal(flags.dl, false);
  assert.equal(flags.title, undefined);
});

test('a mention of an AI in some other page is not a page to close', () => {
  const flags = classify({ title: 'ChatGPT is down - YouTube', bundle: 'com.google.Chrome' });
  assert.deepEqual(flags.ai, ['chatgpt']);
  assert.deepEqual(flags.pages, []);
});

test('a download page is marked without being treated as the AI site', () => {
  const flags = classify({ title: 'Download ChatGPT - Google Chrome', bundle: 'com.google.Chrome' });
  assert.equal(flags.dl, true);
  assert.deepEqual(flags.pages, []);
  assert.deepEqual(flags.ai, ['chatgpt']);
});

test('mac browsers name a safe close command and other apps do not', () => {
  assert.deepEqual(browserControl('com.google.Chrome'), { app: 'Google Chrome', tab: 'active tab' });
  assert.deepEqual(browserControl('com.apple.Safari'), { app: 'Safari', tab: 'current tab' });
  assert.deepEqual(browserControl('org.mozilla.firefox'), { app: 'Firefox', tab: null });
  assert.deepEqual(browserControl('company.thebrowser.browser'), { app: 'Arc', tab: 'active tab' });
  assert.equal(browserControl('com.openai.chat'), null);
  for (const bundle of ['com.microsoft.edgemac', 'com.brave.browser', 'com.operasoftware.opera', 'org.mozilla.nightly']) {
    const plan = browserControl(bundle);
    assert.match(plan.app, /^[A-Za-z0-9 .]+$/);
    assert.ok(plan.tab === null || plan.tab === 'active tab' || plan.tab === 'current tab');
  }
});

test('the desktop app is a rival and not a browser tab', () => {
  const flags = classify({ title: 'New chat', proc: 'chatgpt' });
  assert.deepEqual(flags.ai, ['chatgpt']);
  assert.deepEqual(flags.pages, []);
});
