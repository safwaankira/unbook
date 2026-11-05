#!/usr/bin/env node
// check.mjs <built dist dir> — verifies every internal link and image in the built site resolves.
import fs from 'node:fs'; import path from 'node:path';
const dist = path.resolve(process.argv[2] || 'dist');
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]);
const html = files(dist).filter((f) => f.endsWith('.html'));
const exists = (u) => { const p = decodeURIComponent(u.split(/[?#]/)[0]); const f = path.join(dist, p); return fs.existsSync(f) && (fs.statSync(f).isFile() || fs.existsSync(path.join(f, 'index.html'))); };
const broken = new Map(); let links = 0, remote = new Set();
for (const f of html) {
  const s = fs.readFileSync(f, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  for (const m of s.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const u = m[1];
    if (/gitbook\.io|gitbook\.com/.test(u)) remote.add(u);
    if (!u.startsWith('/') || u.startsWith('//')) continue;
    links++;
    if (!exists(u)) { const k = u.split('#')[0]; broken.set(k, [...(broken.get(k) || []), path.relative(dist, f)]); }
  }
}
console.log(`pages: ${html.length}  internal links/images checked: ${links}  broken: ${broken.size}  still pointing at GitBook: ${remote.size}`);
for (const [u, from] of [...broken].slice(0, 40)) console.log(`  BROKEN ${u}  (on ${[...new Set(from)].slice(0, 3).join(', ')})`);
for (const u of [...remote].slice(0, 15)) console.log(`  GITBOOK ${u.slice(0, 120)}`);
process.exit(broken.size ? 1 : 0);
