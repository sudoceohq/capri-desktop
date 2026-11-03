'use strict';

// No extra runtime dependency on the user's Mac: ship a compiled Swift helper.
// Source development/building needs Apple's Command Line Tools (`xcode-select --install`).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform === 'darwin') {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'native', 'macos', 'CapriHelper.swift');
  const dir = path.join(root, 'native', 'bin');
  const universal = process.argv.includes('--universal');
  const archs = universal ? ['arm64', 'x86_64'] : [process.arch === 'arm64' ? 'arm64' : 'x86_64'];
  fs.mkdirSync(dir, { recursive: true });
  const outputs = archs.map((arch) => {
    const output = path.join(dir, `capri-macos-${arch}`);
    if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < fs.statSync(source).mtimeMs) {
      execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos13.0`, source, '-o', output], { stdio: 'inherit' });
    }
    return output;
  });
  const target = path.join(dir, 'capri-macos');
  if (universal) execFileSync('xcrun', ['lipo', '-create', ...outputs, '-output', target]);
  else fs.copyFileSync(outputs[0], target);
  fs.chmodSync(target, 0o755);
  writeIcon(root);
  console.log(`[capri] macOS helper: ${archs.join(' + ')}`);
}

// electron-builder wants an .icns. The repo only has a 256px PNG, so scale it on the Mac that packs.
function writeIcon(root) {
  const src = path.join(root, 'assets', 'icons', 'capri.png');
  const set = path.join(root, 'native', 'bin', 'capri.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set, { recursive: true });
  const pixels = {
    'icon_16x16.png': 16,
    'icon_16x16@2x.png': 32,
    'icon_32x32.png': 32,
    'icon_32x32@2x.png': 64,
    'icon_128x128.png': 128,
    'icon_128x128@2x.png': 256,
    'icon_256x256.png': 256,
    'icon_256x256@2x.png': 512,
    'icon_512x512.png': 512,
    'icon_512x512@2x.png': 1024,
  };
  for (const [name, size] of Object.entries(pixels)) {
    execFileSync('/usr/bin/sips', ['-z', String(size), String(size), src, '--out', path.join(set, name)], { stdio: 'pipe' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'assets', 'icons', 'capri.icns')], { stdio: 'pipe' });
}
