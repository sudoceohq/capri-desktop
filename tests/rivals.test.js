'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../src/main/rivals');

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

test('the desktop app is a rival and not a browser tab', () => {
  const flags = classify({ title: 'New chat', proc: 'chatgpt' });
  assert.deepEqual(flags.ai, ['chatgpt']);
  assert.deepEqual(flags.pages, []);
});
