#!/usr/bin/env node
// Assemble dist/ — the files the game actually loads in a browser, and nothing else.
//
// An ALLOWLIST on purpose. The deploy that failed used the repo root as its asset directory and
// tried to upload node_modules/workerd (148 MiB, over the 25 MiB per-file limit) along with the
// server, the SQLite databases and the design docs. Listing what ships is the only way that stays
// true as the repo grows: a new file is published because someone added it here.
//
// The list mirrors the <script src> and <link href> tags in index.html — keep them in step.
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');

const FILES = [
  'index.html',
  'manifest.webmanifest',
  'game.js',
  'client-net.js',
  'net-battle.js',
  'real-skin.js',
  'arena-items.js',
  'sim/terra.js',
  'sim/battle.js',
  'sim/settle.js',
  'sim/world-sim.js',
  'vendor/three.min.js',
];
const TREES = ['assets'];                       // rigs, armour cuts, the ruins pack
const MAX = 25 * 1024 * 1024;                   // Cloudflare's per-asset ceiling

function copy(rel) {
  const from = path.join(ROOT, rel), to = path.join(OUT, rel);
  const st = fs.statSync(from);
  if (st.size > MAX) throw new Error(`${rel} is ${(st.size / 1048576).toFixed(1)} MiB — over Cloudflare's 25 MiB asset limit`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return st.size;
}
function walk(rel, hit) {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;       // .DS_Store and friends never ship
    const child = path.posix.join(rel, e.name);
    e.isDirectory() ? walk(child, hit) : hit(child);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
let n = 0, bytes = 0;
for (const f of FILES) {
  if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`missing ${f} — index.html asks for it`);
  bytes += copy(f); n++;
}
for (const t of TREES) walk(t, (f) => { bytes += copy(f); n++; });

// A belt-and-braces check: nothing the server owns may ever reach the CDN.
for (const bad of ['node_modules', 'server', 'train', 'bot', 'perf', 'mocap', 'tools', '.git']) {
  if (fs.existsSync(path.join(OUT, bad))) throw new Error(`${bad}/ leaked into dist/`);
}
console.log(`dist/ built: ${n} files, ${(bytes / 1048576).toFixed(1)} MiB`);
