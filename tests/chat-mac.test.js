'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function browserModule(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${browserModule(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

test('macOS chat routes Music, volume, Bluetooth, and window layout, and drops a refusal', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { Chat } = await import(browserModule(path.resolve(__dirname, '../src/renderer/js/chat.js')));
  const panel = { streamed: '', stream(text) { this.streamed = text; }, setFace() {} };
  const chat = new Chat({
    capri: {}, panel, voice: {},
    host: { platform: 'darwin', onChatDelta() {} },
    brain: { t: { chat: { mediaUnavailable: 'Allow Accessibility.' } }, lang: 'en' },
  });
  chat.open = true;
  assert.equal(chat.asked('Play something thru apple music').action, 'play');
  assert.equal(chat.asked('Play whatever media is paused').action, 'play');
  assert.equal(chat.asked('Hide all apps').what, 'tidy');
  assert.deepEqual(chat.asked('turn the volume up'), { kind: 'pc', what: 'volume', delta: 10 });
  assert.equal(chat.asked('What are connected via bluetooth now?').info, 'bluetooth');
  const placed = chat.asked('Open text edit and put it on the left half of screen');
  assert.equal(placed.what, 'arrange');
  assert.equal(placed.open, 'text edit');
  assert.deepEqual(placed.places, [{ name: 'text edit', side: 'left' }]);
  const prompt = chat.powers().join('\n');
  assert.match(prompt, /Apple Music/);
  assert.match(prompt, /never a PC/);
  chat.history.push({ role: 'assistant', content: "We can't lock your PC." });
  chat.addLine("We can't lock your PC.", 'Lock your Mac?', 'many');
  assert.equal(panel.streamed, 'Lock your Mac?');
  assert.equal(chat.history.at(-1).content, 'Lock your Mac?');

  const windows = new Chat({
    capri: {}, panel, voice: {},
    host: { platform: 'win32', onChatDelta() {} },
    brain: { t: { chat: {} }, lang: 'en' },
  });
  assert.equal(windows.asked('louder').action, 'volup');
  assert.equal(windows.powers().join('\n').includes('their PC'), true);
});
