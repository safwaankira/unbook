#!/usr/bin/env node
// Unbook — migrate a public GitBook site to a self-hosted Starlight (Astro) docs site.
// Usage:
//   node unbook.mjs --url https://docs.example.xyz --out ./example-docs [--name "Example Docs"]
//   node unbook.mjs --from ./gitbook-export --out ./example-docs   (Git Sync repo / folder of .md + SUMMARY.md)
// No dependencies beyond Node 18+. The output is a ready-to-build Astro + Starlight project.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI ----------
const HELP = `Unbook — move a GitBook docs site to a self-hosted Starlight site you own.

Usage
  node unbook.mjs <gitbook docs url> [options]
  node unbook.mjs --from <git-sync folder with SUMMARY.md> [options]

Options
  --out <dir>          output folder (default: <host>-docs)
  --build              also install deps, build the static site and check every link
  --name <title>       site title (default: taken from the docs)
  --site <url>         final docs URL, e.g. https://docs.example.xyz (for the sitemap)
  --demo [note]        add an "unofficial preview" banner + noindex (for sales previews)
  --no-brand           don't copy the logo, favicon and accent colour from GitBook
  --no-video           keep GIFs as GIFs instead of re-encoding them to MP4
  --no-images          keep linking images on GitBook's CDN (fast dry run)
  --max-image-mb <n>   largest file to self-host (default 8)
  --help               this text

Output: an Astro + Starlight project, MIGRATION_REPORT.md, and with --build a ready dist/ folder.`;
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const nx = argv[i + 1]; if (nx !== undefined && !nx.startsWith('--')) { args[a.slice(2)] = nx; i++; } else args[a.slice(2)] = true; }
  else if (!args.url && /^https?:\/\//.test(a)) args.url = a;
}
if (args.help || (!args.url && !args.from)) { console.log(HELP); process.exit(args.help ? 0 : 1); }
if (!args.out) args.out = args.url ? new URL(args.url).hostname.replace(/^docs\./, '').split('.')[0] + '-docs' : path.basename(path.resolve(args.from)) + '-docs';
const c = process.stdout.isTTY ? { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` } : { b: (s) => s, g: (s) => s, y: (s) => s, d: (s) => s };
const step = (msg) => console.log(`${c.g('✓')} ${msg}`);
const OUT = path.resolve(args.out);
const DOCS = path.join(OUT, 'src/content/docs');
const ASSETS = path.join(OUT, 'public/assets');
const report = { pages: 0, images: 0, imageFailures: [], oversize: [], videos: [], warnings: [] };
const MAX_IMG = (Number(args['max-image-mb']) || 8) * 1048576;
const warn = (page, msg) => report.warnings.push(`${page}: ${msg}`);

// ---------- helpers ----------
const UA = { 'user-agent': 'unbook/1.0', accept: 'text/markdown, text/plain, */*' };
async function get(url, { binary = false, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return binary ? { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '' } : await r.text();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url}: ${e.message}`);
      await new Promise((s) => setTimeout(s, 800 * (i + 1)));
    }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const unesc = (s) => String(s ?? '').replace(/\\([\\`*_{}\[\]()#+\-.!&|<>~])/g, '$1');
const stripTags = (s) => decode(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => { const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`)); return m ? decode(m[1]) : null; };
const q = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

// slug for a page path like "getting-started/README" -> "getting-started"
function toSlug(p) {
  let s = p.replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');
  s = s.replace(/(^|\/)README$/i, '').replace(/(^|\/)index$/i, '');
  // match Astro/Starlight's own slugger so links, files and redirects agree (e.g. "g.a.m.e.-x" → "game-x")
  return s.replace(/\/+$/, '').split('/').map((seg) => seg.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-')).join('/');
}

// ---------- discovery ----------
// Returns { title, tree: [{label, slug?, children:[]}], pages: [{slug, url|file, title}] }
function parseMdNav(md, base) {
  // Generic: headings become groups, nested list items become nested entries.
  const root = { children: [] };
  let group = root;
  const stack = [{ indent: -1, node: root }];
  for (const line of md.split('\n')) {
    const h = line.match(/^#{2,4}\s+(.*)$/);
    if (h) {
      group = { label: stripTags(h[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')), children: [] };
      root.children.push(group);
      stack.length = 1; stack.push({ indent: -1, node: group });
      continue;
    }
    const li = line.match(/^(\s*)[*-]\s+\[([^\]]*)\]\(([^)\s]+)\)/);
    if (!li) continue;
    const indent = li[1].replace(/\t/g, '  ').length;
    const label = unesc(li[2].trim());
    const href = li[3];
    const node = { label, href, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root.children;
}

function urlToRel(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  const b = new URL(base);
  if (u.host !== b.host) return null;
  let p = decodeURIComponent(u.pathname);
  const bp = b.pathname.replace(/\/$/, '');
  if (bp && !p.startsWith(bp)) return null;
  p = p.slice(bp.length).replace(/\.md$/i, '');
  return p.replace(/^\/+/, '');
}

// llms.txt / sitemap lists are often flat. If so, rebuild GitBook's hierarchy from URL paths:
// top-level path segment = sidebar group, deeper paths nest under their parent page.
function treeFromPaths(nav) {
  const flat = [];
  const collect = (ns) => ns.forEach((n) => { if (n.slug !== undefined || n.external) flat.push({ ...n, children: [] }); collect(n.children); });
  collect(nav);
  const nested = nav.some((g) => g.children.some((c) => c.children.length)) || nav.filter((g) => g.label && !g.href).length > 2;
  if (nested || flat.length < 8) return nav;
  const WORDS = new Set(['dev', 'app', 'how', 'new', 'old', 'use', 'get', 'set', 'run', 'pay', 'buy', 'map', 'faq-']); const titleCase = (seg) => (seg.replace(/-\d+$/, '').length <= 3 && !WORDS.has(seg.replace(/-\d+$/, '')) ? seg.replace(/-\d+$/, '').toUpperCase() : seg.replace(/-\d+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  const bySlug = new Map(flat.filter((n) => n.slug !== undefined).map((n) => [n.slug, n]));
  const groups = new Map(); const roots = [];
  for (const n of flat) {
    if (n.slug === '' || n.external) { roots.push(n); continue; }
    const parts = n.slug.split('/');
    let parent = null;
    for (let i = parts.length - 1; i > 0 && !parent; i--) parent = bySlug.get(parts.slice(0, i).join('/')) || null;
    if (parent && parent !== n) { parent.children.push(n); continue; }
    if (parts.length === 1) { roots.push(n); continue; }
    const g = parts[0];
    if (!groups.has(g)) { const grp = { label: brand.groupNames[g] || titleCase(g), segment: g, children: [] }; groups.set(g, grp); roots.push(grp); }
    groups.get(g).children.push(n);
  }
  // GitBook can hide whole sections from its sidebar while the pages stay reachable. Its sidebar HTML links
  // every visible top-level section; a top-level section with no link there is hidden on GitBook, so leave it
  // out of ours too (its pages still build and redirect).
  const segOf = (n) => n.segment || (n.slug ? n.slug.split('/')[0] : null);
  const linkedSegs = new Set([...brand.sidebarPaths].map((p) => p.replace(/\.md$/, '').split('/')[0]).filter(Boolean));
  const ours = roots.filter((r) => segOf(r));
  const shown = ours.filter((r) => linkedSegs.has(segOf(r)));
  if (shown.length >= 2) {
    const hidden = ours.filter((r) => !linkedSegs.has(segOf(r)));
    if (hidden.length) {
      brand.hiddenGroups = hidden.map((r) => r.label);
      return roots.filter((r) => !hidden.includes(r));
    }
  }
  return roots;
}

let siteH1 = null;
async function discoverOnline(base) {
  const tries = ['llms.txt', 'sitemap.md'];
  let nav = null, src = null;
  for (const t of tries) {
    const txt = await get(new URL(t, base + '/').href).catch(() => null);
    if (txt && /\]\(/.test(txt)) { nav = parseMdNav(txt, base); src = t; siteH1 = (txt.match(/^#\s+(.+)$/m) || [])[1]; break; }
  }
  if (!nav || !nav.length) {
    const xml = await get(new URL('sitemap.xml', base + '/').href).catch(() => null);
    if (!xml) throw new Error('Could not find llms.txt, sitemap.md or sitemap.xml — is this a public GitBook site?');
    let locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]));
    // sitemap index → fetch children
    if (/<sitemapindex/.test(xml)) {
      const subs = await pool(locs, 4, (l) => get(l).catch(() => ''));
      locs = subs.flatMap((s) => [...s.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1])));
    }
    nav = locs.map((l) => ({ label: null, href: l, children: [] }));
    src = 'sitemap.xml';
  }
  // flatten to pages, keep tree
  const pages = new Map();
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.href) {
      const rel = urlToRel(n.href, base);
      if (rel !== null) {
        n.slug = toSlug(rel);
        if (!pages.has(n.slug)) pages.set(n.slug, { slug: n.slug, url: new URL(n.href, base).href.replace(/\.md$/i, ''), title: n.label });
      } else n.external = n.href;
    }
    walk(n.children);
  });
  walk(nav);
  if (!pages.has('')) pages.set('', { slug: '', url: base, title: null });
  return { nav: treeFromPaths(nav), pages: [...pages.values()], src };
}

function discoverLocal(dir) {
  const summary = ['SUMMARY.md', 'summary.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  let nav = [];
  if (summary) nav = parseMdNav(fs.readFileSync(summary, 'utf8'), 'file:///');
  const pages = new Map();
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.href && !/^https?:/.test(n.href)) {
      n.slug = toSlug(n.href);
      pages.set(n.slug, { slug: n.slug, file: path.join(dir, decodeURIComponent(n.href)), title: n.label });
    } else if (n.href) n.external = n.href;
    walk(n.children);
  });
  walk(nav);
  // pick up any .md files not in SUMMARY
  const all = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith('.') ? [] : e.isDirectory() ? all(path.join(d, e.name)) : e.name.endsWith('.md') ? [path.join(d, e.name)] : []);
  for (const f of all(dir)) {
    const rel = path.relative(dir, f);
    if (/^summary\.md$/i.test(rel)) continue;
    const slug = toSlug(rel);
    if (!pages.has(slug)) { pages.set(slug, { slug, file: f, title: null }); if (summary) warn(rel, 'not in SUMMARY.md — added but not in sidebar'); }
  }
  return { nav, pages: [...pages.values()], src: summary ? 'SUMMARY.md' : 'folder scan' };
}

// ---------- conversion ----------
const HINT = { info: 'note', warning: 'caution', danger: 'danger', success: 'tip' };

function convertHtml(md, ctx) {
  // <figure><img ...><figcaption>..</figcaption></figure>
  md = md.replace(/<figure>([\s\S]*?)<\/figure>/gi, (_, inner) => {
    const img = inner.match(/<img[^>]*>/i);
    const cap = inner.match(/<figcaption>([\s\S]*?)<\/figcaption>/i);
    if (!img) return stripTags(inner);
    const src = (attr(img[0], 'src') || '').replace(/\(/g, '%28').replace(/\)/g, '%29'); const alt = attr(img[0], 'alt') || (cap ? stripTags(cap[1]) : '');
    return `\n![${alt.replace(/[[\]]/g, '')}](${src})${cap && stripTags(cap[1]) ? `\n\n*${stripTags(cap[1])}*` : ''}\n`;
  });
  // card tables
  md = md.replace(/<table[^>]*data-view="cards"[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => {
    const rows = [...inner.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).filter((r) => /<td/i.test(r));
    const cards = rows.map((r) => {
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      const link = r.match(/<a[^>]*href="([^"]+)"/i);
      const texts = cells.map(stripTags).filter((t) => t && !/^\s*$/.test(t) && !/^[\w./-]+\.md$/i.test(t));
      if (!texts.length && !link) return '';
      const title = texts[0] || (link ? stripTags(link[0]) || 'Open' : '');
      const desc = texts.slice(1).join(' — ');
      if (link) return `{% linkcard title="${q(title)}" href="${q(link[1])}"${desc ? ` description="${q(desc)}"` : ''} /%}`;
      return `{% card title="${q(title)}" %}\n${desc}\n{% /card %}`;
    });
    return cards.filter(Boolean).length ? `\n{% cardgrid %}\n${cards.filter(Boolean).join('\n')}\n{% /cardgrid %}\n` : '';
  });
  // other tables → markdown tables
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => {
    const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(c[1].replace(/<\/p>\s*<p[^>]*>/gi, '<br>')
        .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `[${/^\s*<code>[\s\S]*<\/code>\s*$/.test(t) ? '`' + stripTags(t) + '`' : stripTags(t)}](${decode(h)})`)
        .replace(/<\/code>\s*(<br\s*\/?>)?\s*<code>/gi, (_, br) => (br ? '</code>, <code>' : '</code> <code>'))
        .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`').replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/(\S)\s*<br\s*\/?>\s*(?=\S)/gi, '$1 · ')).replace(/\|/g, '\\|')));
    if (!rows.length) return '';
    const w = Math.max(...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(w - r.length).fill('')];
    return `\n| ${pad(rows[0]).join(' | ')} |\n|${' --- |'.repeat(w)}\n${rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`).join('\n')}\n`;
  });
  // details/summary → aside with title
  md = md.replace(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi,
    (_, s, body) => `\n{% aside type="note" title="${q(stripTags(s))}" %}\n${body.trim()}\n{% /aside %}\n`);
  // standalone images
  md = md.replace(/<img[^>]*>/gi, (t) => `![${(attr(t, 'alt') || '').replace(/[[\]]/g, '')}](${(attr(t, 'src') || '').replace(/\(/g, '%28').replace(/\)/g, '%29')})`);
  // anchors
  md = md.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `[${stripTags(t)}](${decode(h)})`);
  // inline formatting
  md = md.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`').replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '  \n').replace(/<\/?(p|div|span|sup|sub|u|picture|source)[^>]*>/gi, '');
  // anything left that looks like an HTML tag outside code → warn (Markdoc shows it as text)
  const left = md.replace(/```[\s\S]*?```|`[^`\n]*`/g, '').match(/<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/gi);
  if (left) warn(ctx.slug, `left as text: ${[...new Set(left.map((t) => t.split(/[\s>]/)[0] + '>'))].join(' ')}`);
  return md;
}

function convertBlocks(md, ctx) {
  // code blocks with titles
  md = md.replace(/\{%\s*code([^%]*)%\}\s*\n(```+)([^\n]*)\n([\s\S]*?)\n\2\s*\n?\{%\s*endcode\s*%\}/g, (_, a, fence, lang, body) => {
    const title = (a.match(/title="([^"]*)"/) || [])[1];
    return `${fence}${lang.trim() || 'text'}${title ? ` {% title="${q(title)}" %}` : ''}\n${body}\n${fence}`;
  });
  // hints
  md = md.replace(/\{%\s*hint\b([^%]*)%\}/g, (_, a) => { const st = (a.match(/style=["'](\w+)["']/) || [])[1]; return `{% aside type="${HINT[st] || 'note'}" %}`; })
    .replace(/\{%\s*hint\s*%\}/g, '{% aside type="note" %}').replace(/\{%\s*endhint\s*%\}/g, '{% /aside %}');
  // tabs
  md = md.replace(/\{%\s*tabs\s*%\}/g, '{% tabs %}').replace(/\{%\s*endtabs\s*%\}/g, '{% /tabs %}')
    .replace(/\{%\s*tab\s+title="([^"]*)"\s*%\}/g, (_, t) => `{% tabitem label="${q(t)}" %}`).replace(/\{%\s*endtab\s*%\}/g, '{% /tabitem %}');
  // content-ref
  md = md.replace(/\{%\s*content-ref\s+url="([^"]*)"\s*%\}([\s\S]*?)\{%\s*endcontent-ref\s*%\}/g, (_, url, inner) => {
    const l = inner.match(/\[([^\]]*)\]\(([^)]*)\)/);
    return `{% linkcard title="${q(l ? l[1] : url)}" href="${q(url)}" /%}`;
  });
  // embeds
  md = md.replace(/\{%\s*embed\s+[^%]*?url="([^"]*)"[^%]*%\}(?:([\s\S]*?)\{%\s*endembed\s*%\})?/g, (_, url, cap) => {
    url = url.replace(/^<|>$/g, ''); if (cap) cap = cap.replace(/\[([^\]]*)\]\(<?[^)>]*>?\)/g, '$1');
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
    const label = (cap && cap.trim()) || (yt ? 'Watch the video' : new URL(url, 'https://x').host);
    return `{% linkcard title="${q(label)}" href="${q(url)}" description="${q(url)}" /%}`;
  });
  // integration blocks with a URL (GitHub code blocks, Figma, etc.) → link card
  md = md.replace(/\{%\s*@([\w/-]+)[^%]*?url="([^"]*)"[^%]*%\}(?:[\s\S]*?\{%\s*end@[\w/-]+\s*%\})?/g, (_, kind, url) => {
    let host = url; try { host = new URL(url).host; } catch {}
    return `{% linkcard title="${q(/github/.test(kind) ? 'View the code on GitHub' : 'Open on ' + host)}" href="${q(url)}" description="${q(url)}" /%}`;
  });
  // files
  md = md.replace(/\{%\s*file\s+src="([^"]*)"\s*%\}(?:([\s\S]*?)\{%\s*endfile\s*%\})?/g,
    (_, src, cap) => `📎 [${(cap && cap.trim()) || path.basename(src.split('?')[0])}](${src})`);
  // stepper → Steps ordered list
  md = md.replace(/\{%\s*stepper\s*%\}([\s\S]*?)\{%\s*endstepper\s*%\}/g, (_, inner) => {
    const steps = [...inner.matchAll(/\{%\s*step\s*%\}([\s\S]*?)\{%\s*endstep\s*%\}/g)].map((m) => m[1].trim());
    const items = steps.map((s) => {
      const lines = s.split('\n');
      const first = lines.shift().replace(/^#{1,6}\s+/, '');
      return `1. ${first}\n${lines.map((l) => (l.trim() ? '   ' + l : '')).join('\n')}`;
    });
    return `{% steps %}\n${items.join('\n\n')}\n{% /steps %}`;
  });
  // changelog updates
  md = md.replace(/\{%\s*updates[^%]*%\}|\{%\s*endupdates\s*%\}|\{%\s*endupdate\s*%\}/g, '')
    .replace(/\{%\s*update\s+date="([^"]*)"\s*%\}/g, '## $1');
  // OpenAPI blocks
  md = md.replace(/\{%\s*(swagger|openapi)[^%]*src="([^"]*)"[^%]*%\}[\s\S]*?\{%\s*end(swagger|openapi)\s*%\}/g, (_, k, src) => {
    warn(ctx.slug, 'OpenAPI block converted to a link (render with starlight-openapi if needed)');
    return `{% aside type="note" title="API reference" %}\nSpec: [${src}](${src})\n{% /aside %}`;
  });
  // layout-only wrappers
  md = md.replace(/\{%\s*(end)?columns?[^%]*%\}/g, '');
  // reusable content we can't resolve
  md = md.replace(/\{%\s*include\s+"([^"]*)"\s*%\}/g, (_, p) => { warn(ctx.slug, `reusable block ${p} not resolved`); return ''; });
  // anything else GitBook-ish: strip opening/closing, keep content
  const known = /^(\/?(aside|tabs|tabitem|linkcard|card|cardgrid|steps|badge|linkbutton|icon|filetree)\b|title=)/;
  md = md.replace(/\{%\s*([^%]*?)\s*\/?%\}/g, (m, inner) => {
    if (known.test(inner.trim())) return m;
    warn(ctx.slug, `unknown GitBook block "{% ${inner.split(/\s/)[0]} %}" stripped`);
    return '';
  });
  return md;
}

function rewriteLinks(md, ctx) {
  const fix = (href) => {
    href = href.replace(/^<|>$/g, '');
    if (!href || /^(#|mailto:|tel:)/.test(href)) return href;
    if (/^broken:/.test(href)) { warn(ctx.slug, 'link GitBook already marks as broken removed'); return '#'; }
    if (/^internal:/.test(href)) { warn(ctx.slug, `GitBook-internal link ${href} removed`); return '#'; }
    const gid = href.match(/^(?:https?:\/\/[^/]+)?(?:\/[^#]*?)?\/(pages|files)\/([A-Za-z0-9]{16,})/);
    if (gid) { ctx.gbIds.add(gid[1] + '/' + gid[2]); return `__GBID_${gid[1]}_${gid[2]}__`; }
    const [h, hash] = href.split('#');
    if (/^https?:/.test(h) || (h.startsWith('/') && ctx.base)) {
      if (!ctx.base) return href;
      const rel = urlToRel(new URL(h, ctx.base).href, ctx.base);
      if (rel === null) return href;
      return '/' + (toSlug(rel) ? toSlug(rel) + '/' : '') + (hash ? '#' + hash : '');
    }
    if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4)$/i.test(h)) return href;
    if (h.startsWith('/')) return '/' + (toSlug(h) ? toSlug(h) + '/' : '') + (hash ? '#' + hash : '');
    // relative page link (.md / README)
    const dir = path.posix.dirname(ctx.slug + '/x');
    const fromDir = ctx.isIndex ? ctx.slug : path.posix.dirname(ctx.slug) === '.' ? '' : path.posix.dirname(ctx.slug);
    const target = toSlug(path.posix.normalize(path.posix.join(ctx.file ? path.posix.dirname(ctx.relFile) : fromDir, h)));
    return '/' + (target && target !== '.' ? target + '/' : '') + (hash ? '#' + hash : '');
  };
  md = md.replace(/(!?)\[((?:\\.|[^\]\\])*)\]\((<[^>]+>|[^)\s]+)(\s+"[^"]*")?\)/g, (m, bang, t, h, title) => (bang ? m : `[${t}](${fix(h)}${title || ''})`));
  md = md.replace(/(linkcard[^%]*href=")([^"]+)"/g, (_, a, h) => `${a}${fix(h)}"`);
  return md;
}

// GIFs are re-encoded to MP4 (10–50x smaller) when ffmpeg is available.
const HAS_FFMPEG = !args['no-video'] && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const GIF_MIN = (Number(args['gif-mb']) || 1) * 1048576;
const mediaCache = new Map();
let smallGifs = 0; // source key -> { local, video } (same image used on many pages)
async function gifToMp4(buf, name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unbook-'));
  const inF = path.join(tmp, 'in.gif'); const outF = path.join(ASSETS, name);
  fs.writeFileSync(inF, buf);
  const r = await new Promise((res) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', inF, '-movflags', 'faststart', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(min(iw\\,1600)/2)*2:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-an', outF]);
    p.on('close', (code) => res(code));
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r === 0 && fs.existsSync(outF) ? fs.statSync(outF).size : null;
}
async function storeMedia(key, buf, ext, label) {
  if (mediaCache.has(key)) return mediaCache.get(key);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  let res = null;
  if (ext === '.gif' && HAS_FFMPEG && buf.length >= GIF_MIN) {
    const size = await gifToMp4(buf, hash + '.mp4');
    if (size !== null && size <= MAX_IMG) {
      report.videos.push({ from: buf.length, to: size }); res = { local: '/assets/' + hash + '.mp4', video: true };
    }
  }
  if (!res && ext === '.gif') smallGifs++;
  if (!res && buf.length > MAX_IMG) { report.oversize.push(`${(buf.length / 1048576).toFixed(1)} MB — ${label}`); res = null; }
  else if (!res) { fs.writeFileSync(path.join(ASSETS, hash + ext), buf); res = { local: '/assets/' + hash + ext, video: false }; }
  mediaCache.set(key, res);
  return res;
}

async function localizeImages(md, ctx) {
  const urls = new Set();
  md.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_, u) => urls.add(u));
  for (const u of urls) {
    let real = u;
    try {
      const parsed = new URL(u, ctx.base || 'file:///');
      if (parsed.pathname.includes('/~gitbook/image') && parsed.searchParams.get('url')) real = parsed.searchParams.get('url');
      else real = parsed.href;
    } catch { continue; }
    let got = null;
    try {
      if (ctx.file && !/^https?:/.test(u)) {
        const f = path.resolve(path.dirname(ctx.file), decodeURIComponent(u));
        if (fs.existsSync(f)) got = await storeMedia(f, fs.readFileSync(f), path.extname(f).toLowerCase(), u);
      } else if (!args['no-images'] && /^https?:/.test(real)) {
        if (mediaCache.has(real)) got = mediaCache.get(real);
        else {
          const r = await get(real, { binary: true });
          if (r) {
            const ext = (path.extname(decodeURIComponent(new URL(real).pathname)).split('?')[0] || '.' + (r.type.split('/')[1] || 'png').split(/[+;]/)[0]).toLowerCase();
            got = await storeMedia(real, r.buf, /gif/.test(r.type) ? '.gif' : ext, real);
          }
        }
      }
    } catch (e) { report.imageFailures.push(real); }
    if (got && got.video) {
      report.images++;
      // a GIF alone on its line becomes a video block; inline ones still get the video file
      md = md.replace(new RegExp(`^([ \\t]*)!\\[([^\\]]*)\\]\\(${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)[ \\t]*$`, 'gm'),
        (_, ind, alt) => `${ind}{% video src="${got.local}"${alt ? ` title="${q(alt)}"` : ''} /%}`);
      md = md.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g'), (_, alt) => `[▶ ${alt || 'video'}](${got.local})`);
    } else if (got) { report.images++; md = md.split(`](${u})`).join(`](${got.local})`); }
    else if (/^https?:/.test(real) && real !== u) md = md.split(`](${u})`).join(`](${real})`);
  }
  return md;
}

function frontmatter(md, fallbackTitle) {
  let meta = {};
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split('\n')) { const m = line.match(/^(\w+):\s*(.*)$/); if (m) meta[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
    md = md.slice(fm[0].length);
  }
  let title = fallbackTitle;
  const h1 = md.match(/^\s*#\s+(.+)\s*\n/);
  if (h1) { title = h1[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(); md = md.slice(h1[0].length); }
  const lines = ['---', `title: "${q(unesc(stripTags(title || 'Untitled')))}"`];
  if (meta.description && meta.description !== '>-') lines.push(`description: "${q(meta.description)}"`);
  lines.push('---', '');
  return lines.join('\n') + md.trim() + '\n';
}

// GitBook's .md export appends page-level boilerplate; drop it.
function cleanExport(md) {
  return md.replace(/\r\n/g, '\n').replace(/\n#{1,3} Agent Instructions\nThis documentation is published with GitBook[\s\S]*$/, '\n').replace(/^>\s*For the complete documentation index[^\n]*\n+/i, '').replace(/&#x20;/g, ' ').replace(/\n*\[(Previous|Next)\]\([^)]*\)\s*$/g, '')
    .replace(/\n+Last updated \d+.*$/i, '').replace(/^\s*\n/, '');
}

async function convertPage(page, ctx0) {
  const ctx = { ...ctx0, slug: page.slug || 'index', isIndex: true };
  let md;
  if (page.file) {
    if (!fs.existsSync(page.file)) { warn(page.slug, 'file listed in SUMMARY.md is missing'); return null; }
    md = fs.readFileSync(page.file, 'utf8');
    ctx.file = page.file; ctx.relFile = path.relative(ctx0.dir, page.file).split(path.sep).join('/');
  } else {
    md = await get(page.url.replace(/\/$/, '') + '.md').catch(() => null);
    if (!md || /^\s*<!doctype html/i.test(md)) md = await get(page.url, {}).catch(() => null);
    if (!md || /^\s*<!doctype html/i.test(md)) { warn(page.slug, 'could not fetch markdown'); return null; }
    if (/The URL `[^`]*` does not exist|^#\s*Page not found/im.test(md.slice(0, 600))) { if (page.slug) warn(page.slug, 'GitBook returned its 404 page — skipped'); return null; }
  }
  md = cleanExport(md);
  // protect fenced code from transforms
  const fences = [];
  const protect = (s) => s.replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, (m) => {
    // keep {% code %} wrappers outside; only inner fence is protected
    fences.push(m); return `\u0000F${fences.length - 1}\u0000`;
  });
  const rawFence = (f) => {
    if (!/\{%/.test(f.split('\n').slice(1).join('\n'))) return f;
    return f.replace(/^([`~]+[^\n]*?)(?:\s*\{%([^%]*)%\})?\n/, (m, head, a) => `${head.trimEnd() || head} {% ${a ? a.trim() + ' ' : ''}process=false %}\n`);
  };
  const restore = (s) => s.replace(/\u0000F(\d+)\u0000/g, (_, i) => rawFence(fences[+i]));
  // code-with-title wrapper needs the fence visible → handle before protecting
  md = md.replace(/\{%\s*code([^%]*)%\}\s*\n(```+)([^\n]*)\n([\s\S]*?)\n\2\s*\n?\{%\s*endcode\s*%\}/g, (_, a, fence, lang, body) => {
    const title = (a.match(/title="([^"]*)"/) || [])[1];
    return `${fence}${lang.trim() || 'text'}${title ? ` {% title="${q(title)}" %}` : ''}\n${body}\n${fence}`;
  });
  md = md.replace(/<pre[^>]*>\s*<code(?:\s+class="lang-([\w+-]+)")?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, lang, body) => {
    const code = decode(body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\*\*/g, '').replace(/\n+$/, '');
    return `\n\`\`\`${lang || 'text'}\n${code}\n\`\`\`\n`;
  });
  md = protect(md);
  for (let prev; prev !== md;) { prev = md; md = md.replace(/(`[^`\n]+)``(?=[^`\n]+`)/, '$1`, `'); }
  md = convertHtml(md, ctx);
  md = convertBlocks(md, ctx);
  md = rewriteLinks(md, ctx);
  // Markdoc block tags must sit at column 0 on their own line, separated from lists/paragraphs.
  md = md.replace(/^[ \t]+(\{%[^%]*%\})[ \t]*$/gm, '$1')
    .replace(/([^\n])\n(\{%[^%]*%\}[ \t]*)$/gm, '$1\n\n$2')
    .replace(/^(\{%[^%]*%\})[ \t]*\n(?!\n)/gm, '$1\n\n');
  md = restore(md);
  md = await localizeImages(md, ctx);
  md = frontmatter(md, page.title || page.slug);
  md = md.replace(/^#{1,6}[ \t]*(\*\*)?[ \t]*(\*\*)?[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n');
  const out = path.join(DOCS, (page.slug || 'index') + (page.slug ? '' : '') + '.mdoc');
  const target = page.slug ? path.join(DOCS, page.slug + '.mdoc') : path.join(DOCS, 'index.mdoc');
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, md);
  report.pages++;
  return { slug: page.slug, title: md.match(/^title: "(.*)"$/m)[1].replace(/\\"/g, '"') };
}

// ---------- sidebar ----------
function buildSidebar(nav, written) {
  const ok = new Set(written.map((w) => w.slug));
  const titles = Object.fromEntries(written.map((w) => [w.slug, w.title]));
  const conv = (n, depth = 0) => {
    const kids = n.children.map((c) => conv(c, depth + 1)).filter(Boolean);
    const self = n.slug !== undefined && ok.has(n.slug) ? { label: n.label || titles[n.slug], link: '/' + (n.slug ? n.slug + '/' : '') } : n.external ? { label: n.label, link: n.external, attrs: { target: '_blank' } } : null;
    if (!kids.length) return self;
    return { label: n.label || (self && self.label) || 'Section', collapsed: depth > 0, items: self ? [{ ...self, label: 'Overview' }, ...kids] : kids };
  };
  let side = nav.map((n) => conv(n, 0)).filter(Boolean);
  if (!side.length) side = written.filter((w) => w.slug).map((w) => ({ label: w.title, link: '/' + w.slug + '/' }));
  return side;
}

// ---------- project scaffold ----------
function writeProject(title, sidebar, sourceUrl) {
  const t = fs.readFileSync(path.join(HERE, 'template/astro.config.tmpl.mjs'), 'utf8')
    .replace('__TITLE__', JSON.stringify(title)).replace('__SITE__', JSON.stringify(args.site || (sourceUrl ? new URL(sourceUrl).origin : 'https://example.com'))).replace('__SIDEBAR__', JSON.stringify(sidebar, null, 2))
    .replace('__LOGO__', brand.logo ? JSON.stringify(brand.logo) : 'undefined').replace('__FAVICON__', JSON.stringify(brand.favicon || '/favicon.svg'))
    .replace('__HEAD__', args.demo ? JSON.stringify([{ tag: 'meta', attrs: { name: 'robots', content: 'noindex,nofollow' } }]) : '[]')
    .replace('__SOCIAL__', sourceUrl ? `[{ icon: 'external', label: 'Original docs', href: ${JSON.stringify(sourceUrl)} }]` : '[]');
  fs.writeFileSync(path.join(OUT, 'astro.config.mjs'), t);
  for (const [f, to] of [['markdoc.config.mjs'], ['package.tmpl.json', 'package.json'], ['tsconfig.json'], ['README.md']]) {
    const src = path.join(HERE, 'template', f);
    if (fs.existsSync(src)) fs.writeFileSync(path.join(OUT, to || f), fs.readFileSync(src, 'utf8').replace(/__TITLE__/g, title));
  }
  if (!fs.existsSync(path.join(OUT, 'public/favicon.svg')) && !brand.favicon) fs.copyFileSync(path.join(HERE, 'template/favicon.svg'), path.join(OUT, 'public/favicon.svg'));
  ensureDir(path.join(OUT, 'src/components'));
  for (const f of fs.readdirSync(path.join(HERE, 'template/components'))) fs.copyFileSync(path.join(HERE, 'template/components', f), path.join(OUT, 'src/components', f));
  ensureDir(path.join(OUT, 'src'));
  fs.copyFileSync(path.join(HERE, 'template/content.config.ts'), path.join(OUT, 'src/content.config.ts'));
  ensureDir(path.join(OUT, 'src/styles'));
  let css = fs.readFileSync(path.join(HERE, 'template/custom.css'), 'utf8');
  if (brand.colors) {
    const { light: L, dark: D } = brand.colors;
    if (brand.lightLogoIsWhite) css += `\n/* GitBook shows this white logo on a brand-coloured header; do the same in light mode */\n:root[data-theme='light'] header.header { background: ${L.accent}; border-color: transparent; }\n:root[data-theme='light'] header.header :is(.site-title, button, a, starlight-theme-select, select, svg) { color: #fff; }\n:root[data-theme='light'] header.header site-search button[data-open-modal] { background: rgb(255 255 255 / 0.15); border-color: rgb(255 255 255 / 0.35); color: #fff; }\n:root[data-theme='light'] header.header site-search kbd { background: rgb(255 255 255 / 0.2); color: #fff; }\n`;
    css += `\n/* Brand colours copied from the GitBook site */\n:root { --sl-color-accent: ${D.accent}; --sl-color-accent-high: ${D.high}; --sl-color-accent-low: ${D.low}; }\n:root[data-theme='light'] { --sl-color-accent: ${L.accent}; --sl-color-accent-high: ${L.high}; --sl-color-accent-low: ${L.low}; }\n`;
  }
  fs.writeFileSync(path.join(OUT, 'src/styles/custom.css'), css);
}

const brand = { applied: [], favicon: null, logo: null, colors: null, groupNames: {}, sidebarPaths: new Set() };
// Copy the logo, favicon and accent colour from the GitBook site itself (best effort).
function imgSize(buf) {
  if (buf.slice(1, 4).toString() === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  const svg = buf.slice(0, 2000).toString();
  const vb = svg.match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/);
  if (vb) return { w: +vb[1], h: +vb[2] };
  return null;
}
// Average lightness of a PNG's visible pixels (0–1), or null if it can't be read. Used to tell a
// white logo (GitBook shows those on a coloured header) from a dark one.
function pngLightness(buf) {
  try {
    if (buf.slice(1, 4).toString() !== 'PNG') return null;
    let o = 8, w, h, depth, type, inter, plte = null, trns = null; const idat = [];
    while (o < buf.length) {
      const len = buf.readUInt32BE(o), t = buf.slice(o + 4, o + 8).toString(), d = buf.slice(o + 8, o + 8 + len);
      if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
      if (t === 'PLTE') plte = d;
      if (t === 'tRNS') trns = d;
      if (t === 'IDAT') idat.push(d);
      if (t === 'IEND') break;
      o += 12 + len;
    }
    const ch = { 6: 4, 2: 3, 4: 2, 0: 1, 3: 1 }[type];
    if (!ch || inter || (type !== 3 && depth !== 8) || (type === 3 && !plte)) return null;
    const bpp = Math.max(1, (ch * depth) >> 3), stride = Math.ceil((w * ch * depth) / 8);
    const raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
        let v = row[x];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const p0 = a + b - c, pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        px[y * stride + x] = v & 255;
      }
    }
    const lum = (r, g, bl) => (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
    let sum = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r, g, bl, al;
      if (type === 3) {
        const bit = x * depth, byte = px[y * stride + (bit >> 3)], idx = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        r = plte[idx * 3]; g = plte[idx * 3 + 1]; bl = plte[idx * 3 + 2]; al = trns && idx < trns.length ? trns[idx] : 255;
      } else {
        const i = y * stride + x * ch;
        if (ch >= 3) { r = px[i]; g = px[i + 1]; bl = px[i + 2]; } else r = g = bl = px[i];
        al = ch === 4 ? px[i + 3] : ch === 2 ? px[i + 1] : 255;
      }
      if (al < 128) continue;
      sum += lum(r, g, bl); n++;
    }
    return n ? sum / n : null;
  } catch { return null; }
}
async function fetchBrand(baseUrl) {
  let html;
  try { const r = await fetch(baseUrl, { headers: { 'user-agent': UA['user-agent'], accept: 'text/html' }, redirect: 'follow' }); if (!r.ok) return; html = await r.text(); } catch { return; }
  const unwrap = (u) => { try { const x = new URL(decode(u), baseUrl); return x.pathname.includes('/~gitbook/image') && x.searchParams.get('url') ? x.searchParams.get('url') : x.href; } catch { return null; } };
  const dl = async (u, name) => { try { const r = await get(u, { binary: true }); if (!r || !r.buf.length) return null; const ext = /svg/.test(r.type) ? '.svg' : /jpe?g/.test(r.type) ? '.jpg' : /webp/.test(r.type) ? '.webp' : '.png'; return { buf: r.buf, file: name + ext }; } catch { return null; } };
  // sidebar section names, exactly as GitBook shows them (group header → first link under it)
  const bp = new URL(baseUrl).pathname.replace(/\/$/, '');
  const re = /class="[^"]*\btoc-group\b[^"]*"[^>]*>([\s\S]*?)(?:<span class="toc-group-chevron|<\/button>|<\/div>)|<a[^>]*href="([^"]+)"/g;
  const nameOf = (inner) => {
    const flex = inner.match(/<span class="[^"]*\bflex-1\b[^"]*">([\s\S]*?)<\/span>/);
    const txt = stripTags(flex ? flex[1] : inner).replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '').trim();
    return txt || null;
  };
  let m, cur = null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) { cur = nameOf(m[1]); continue; }
    if (m[2]) { try { const pp = new URL(decode(m[2]), baseUrl).pathname; if (pp.startsWith(bp + '/')) brand.sidebarPaths.add(pp.slice(bp.length + 1).replace(/\/$/, '')); } catch {} }
    if (!cur) continue;
    let pth; try { pth = new URL(decode(m[2]), baseUrl).pathname; } catch { continue; }
    if (!pth.startsWith(bp + '/')) continue;
    const seg = pth.slice(bp.length + 1).split('/')[0];
    if (seg && !brand.groupNames[seg]) brand.groupNames[seg] = cur;
    cur = null;
  }
  // logo (light + dark variants)
  const logos = [...html.matchAll(/<img alt="Logo"[^>]*class="([^"]*)"[^>]*src="([^"]+)"/g)];
  const light = logos.find((m) => /\bblock dark:hidden\b/.test(m[1])) || logos[0];
  const dark = logos.find((m) => /\bhidden dark:block\b/.test(m[1]));
  if (light) {
    const lg = await dl(unwrap(light[2]), 'logo-light');
    const dk = dark && dark[2] !== light[2] ? await dl(unwrap(dark[2]), 'logo-dark') : null;
    if (lg) {
      ensureDir(path.join(OUT, 'src/assets'));
      fs.writeFileSync(path.join(OUT, 'src/assets', lg.file), lg.buf);
      if (dk) fs.writeFileSync(path.join(OUT, 'src/assets', dk.file), dk.buf);
      const sz = imgSize(lg.buf);
      brand.lightLogoIsWhite = (pngLightness(lg.buf) ?? 0) > 0.82;
      brand.logo = { light: './src/assets/' + lg.file, dark: './src/assets/' + (dk ? dk.file : lg.file), replacesTitle: !!(sz && sz.w / sz.h > 2.2) };
      brand.applied.push('logo');
    }
  }
  // favicon
  const icon = (html.match(/<link rel="icon" href="([^"]+)"/) || [])[1];
  if (icon) { const f = await dl(new URL(decode(icon), baseUrl).href, 'favicon'); if (f) { fs.writeFileSync(path.join(OUT, 'public', f.file), f.buf); brand.favicon = '/' + f.file; brand.applied.push('favicon'); } }
  // colours: GitBook prints a 12-step --primary scale, light theme first, then dark
  const scale = (n) => [...html.matchAll(new RegExp(`--primary-${n}:\\s*(\\d+) (\\d+) (\\d+)`, 'g'))].map((m) => `rgb(${m[1]} ${m[2]} ${m[3]})`);
  const p3 = scale(3), p9 = scale(9), p10 = scale(10), p11 = scale(11), p12 = scale(12);
  if (p9.length && p3.length >= 2 && p10.length >= 2 && p11.length >= 2) {
    brand.colors = { light: { accent: p9[0], high: p12[0] || p11[0], low: p3[0] }, dark: { accent: p10[1], high: p11[1], low: p3[1] } };
    brand.applied.push('accent colour');
  }
}

// ---------- main ----------
const t0 = Date.now();
ensureDir(DOCS); ensureDir(ASSETS);
let disc, base = null, dir = null;
if (args.url) {
  base = String(args.url).replace(/\/+$/, '');
  if (!args['no-brand']) { await fetchBrand(base); if (brand.applied.length) step(`Copied ${brand.applied.join(', ')} from the GitBook site`); }
  disc = await discoverOnline(base);
} else {
  dir = path.resolve(args.from);
  disc = discoverLocal(dir);
}
step(`Found ${c.b(disc.pages.length)} pages on ${base || dir} ${c.d(`(via ${disc.src})`)}`);
let siteTitle = args.name;
const gbIds = new Set();
const written = (await pool(disc.pages, 6, async (p) => {
  try { return await convertPage(p, { base, dir, gbIds }); }
  catch (e) { warn(p.slug, e.message); return null; }
})).filter(Boolean);
step(`Converted ${c.b(report.pages)} pages, self-hosted ${c.b(report.images)} images${report.videos.length ? `, turned ${c.b(report.videos.length)} GIFs into MP4` : ''}`);
if (!siteTitle) siteTitle = siteH1 || (written.find((w) => w.slug === '') || {}).title || (base ? new URL(base).host : 'Docs');
// post-pass: resolve GitBook object IDs (/pages/<id>, /files/<id>) left by the .md export
const gbMap = {};
const titleIndex = Object.fromEntries(written.map((w) => [w.title.replace(/[`*_]/g, '').toLowerCase().trim(), w.slug]));
if (base) await pool([...gbIds], 4, async (key) => {
  const [kind, id] = key.split('/');
  const b = new URL(base);
  for (const u of [`${b.origin}${b.pathname.replace(/\/$/, '')}/${kind}/${id}`, `${b.origin}/${kind}/${id}`]) {
    try {
      const r = await fetch(u, { headers: UA, redirect: 'follow' });
      const type = r.headers.get('content-type') || '';
      if (!r.ok) continue;
      if (kind === 'pages' && r.url !== u) { const rel = urlToRel(r.url, base); const sl = rel === null ? null : toSlug(rel); if (sl !== null && written.some((w) => w.slug === sl)) { gbMap[key] = '/' + (sl ? sl + '/' : ''); return; } }
      if (kind === 'files' && !/text\/html/.test(type)) {
        const cd = r.headers.get('content-disposition') || '';
        const fname = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1] || path.basename(new URL(r.url).pathname) || id;
        const name = id.slice(0, 8) + '-' + decodeURIComponent(fname).replace(/[^\w.-]+/g, '_');
        fs.writeFileSync(path.join(ASSETS, name), Buffer.from(await r.arrayBuffer()));
        gbMap[key] = '/assets/' + name; return;
      }
    } catch {}
  }
});
const slugSet = new Set(written.map((w) => w.slug));
const walkDocs = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkDocs(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walkDocs(DOCS)) {
  const pageSlug = path.relative(DOCS, f).replace(/\.mdoc$/, '').replace(/(^|\/)index$/, '');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace(/\[((?:\\.|[^\]\\])*)\]\(__GBID_(pages|files)_([A-Za-z0-9]+)__\)/g, (m, text, kind, id) => {
    const key = `${kind}/${id}`;
    if (gbMap[key]) return `[${text}](${gbMap[key]})`;
    const norm = stripTags(text).replace(/[`*_]/g, '').toLowerCase().trim();
    let bySlug = titleIndex[norm];
    if (bySlug === undefined && norm.length >= 4) {
      const key = norm.replace(/[^a-z0-9]+/g, '-');
      const hits = written.filter((w) => (w.slug.split('/').pop() || '').startsWith(key) || w.title.replace(/[`*_]/g, '').toLowerCase().startsWith(norm));
      if (hits.length === 1) bySlug = hits[0].slug;
    }
    if (kind === 'pages' && bySlug !== undefined) return `[${text}](/${bySlug ? bySlug + '/' : ''})`;
    warn(pageSlug || 'index', `unresolved GitBook ${kind === 'pages' ? 'page' : 'file'} link "${text}" (${id})${kind === 'files' ? ' — download it from GitBook and put it in public/assets' : ''}`);
    return kind === 'files' && base ? `[${text}](${new URL(base).origin}${new URL(base).pathname.replace(/\/$/, '')}/files/${id})` : text;
  }).replace(/\{% linkcard title="([^"]*)" href="__GBID_(pages|files)_([A-Za-z0-9]+)__"([^%]*)\/%\}/g, (m, title, kind, id, rest) => {
    const key = `${kind}/${id}`;
    const t = title.replace(/\\"/g, '"');
    const bySlug = titleIndex[t.toLowerCase().trim()];
    const href = gbMap[key] || (kind === 'pages' && bySlug !== undefined ? `/${bySlug ? bySlug + '/' : ''}` : null);
    if (href) return `{% linkcard title="${title}" href="${href}"${rest}/%}`;
    warn(pageSlug || 'index', `card "${t}" pointed at an unresolved GitBook ${kind} (${id}) — shown as plain text`);
    return `**${t}**`;
  }).replace(/__GBID_(pages|files)_([A-Za-z0-9]+)__/g, (m, kind, id) => { warn(pageSlug || 'index', `unresolved GitBook ${kind} id ${id}`); return '#'; });
  // dead internal links
  for (const m of src.matchAll(/\]\((\/[^)#\s]*)(#[^)\s]*)?\)|href="(\/[^"#]*)/g)) {
    const t = (m[1] || m[3]).replace(/^\/|\/$/g, '');
    if (t === '' || t.startsWith('assets/') || slugSet.has(t)) continue;
    warn(pageSlug || 'index', `link to /${t}/ — no such page (also dead on the original site?)`);
  }
  fs.writeFileSync(f, src);
}
// no usable home page → generate one from the top-level sections
if (!slugSet.has('')) {
  const top = disc.nav.filter((n) => n.label);
  const cards = top.map((n) => {
    const first = (function find(x) { if (x.slug !== undefined && slugSet.has(x.slug)) return x.slug; for (const c of x.children) { const r = find(c); if (r !== null) return r; } return null; })(n);
    const kids = n.children.map((c) => c.label).filter(Boolean);
    const desc = kids.slice(0, 4).join(' · ') + (kids.length > 4 ? ` · +${kids.length - 4} more` : '');
    return first !== null ? `{% linkcard title="${q(n.label)}" href="/${first ? first + '/' : ''}"${desc ? ` description="${q(desc)}"` : ''} /%}` : '';
  }).filter(Boolean);
  const t = siteTitle || args.name || 'Documentation';
  fs.writeFileSync(path.join(DOCS, 'index.mdoc'), `---\ntitle: "${q(t)}"\ntemplate: splash\nhero:\n  tagline: "Everything you need to use and build on ${q(t.replace(/\s*(docs?|documentation|whitepaper|wiki|gitbook|guides?)$/i, ''))}."\n---\n\n{% cardgrid %}\n${cards.join('\n')}\n{% /cardgrid %}\n`);
  written.push({ slug: '', title: t });
  report.warnings.push('index: GitBook had no root page — generated a landing page from the sidebar sections');
}
// post-pass: link cards titled with a filename → the target page's real title
const titleBySlug = Object.fromEntries(written.map((w) => [w.slug, w.title]));
const walkFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walkFiles(DOCS)) {
  const src = fs.readFileSync(f, 'utf8');
  const out = src.replace(/\{% linkcard title="([^"]*)" href="(\/[^"#]*)([^"]*)"/g, (m, t, h, hash) => {
    const slug = h.replace(/^\/|\/$/g, '');
    if (titleBySlug[slug] !== undefined && (/\.md$/i.test(t) || /^readme$/i.test(t) || t === h)) return `{% linkcard title="${q(titleBySlug[slug])}" href="${h}${hash}"`;
    return m;
  });
  if (out !== src) fs.writeFileSync(f, out);
}
if (args.demo) {
  const who = siteTitle.replace(/\s*(docs?|documentation|whitepaper|wiki|gitbook|guides?)$/i, '');
  const note = `Unofficial preview, not affiliated with ${who}.${typeof args.demo === 'string' ? ' ' + args.demo : ''}`;
  for (const f of walkDocs(DOCS)) {
    const src = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, src.replace(/^---\n/, `---\nbanner:\n  content: "${q(note)}"\n`));
  }
}
const sidebar = buildSidebar(disc.nav, written);
writeProject(siteTitle, sidebar, base);
// ---------- redirects: keep every old GitBook URL working ----------
// GitBook often serves docs under a path (docs.x.fi/moonwell/...); the new site lives at the root.
// One wildcard rule per host format covers every page, and redirects.json lists each old → new pair
// so the build step can prove they all land on a real page.
const redirects = { basePath: '', pairs: [] };
if (base) {
  const bp = new URL(base).pathname.replace(/\/+$/, '');
  redirects.basePath = bp;
  for (const w of written) {
    const pg = disc.pages.find((p) => p.slug === w.slug);
    const oldPath = pg && pg.url ? new URL(pg.url).pathname.replace(/\/+$/, '') || '/' : (bp + (w.slug ? '/' + w.slug : '')) || '/';
    redirects.pairs.push({ from: oldPath, to: '/' + (w.slug ? w.slug + '/' : '') });
  }
  // pages whose path changed beyond the base-path move (slug cleanup, e.g. dots) need their own rule
  const strip = (p) => (bp && (p === bp || p.startsWith(bp + '/')) ? p.slice(bp.length) || '/' : p);
  const exact = redirects.pairs.filter((x) => strip(x.from).replace(/\/?$/, '/') !== x.to);
  redirects.exact = exact;
  const nl = [`# Old GitBook URLs → new pages (Netlify + Cloudflare Pages)`];
  for (const x of exact) nl.push(`${x.from}  ${x.to}  301`, `${x.from}/  ${x.to}  301`);
  if (bp) nl.push(`${bp}  /  301`, `${bp}/  /  301`, `${bp}/*  /:splat  301`);
  const vRedirects = [
    // Vercel applies trailingSlash first (/a/b → /a/b/), so each source is matched with its slash
    ...exact.flatMap((x) => [{ source: x.from + '/', destination: x.to, statusCode: 301 }, { source: x.from, destination: x.to, statusCode: 301 }]),
    ...(bp ? [{ source: bp, destination: '/', statusCode: 301 }, { source: `${bp}/:path(.*)`, destination: '/:path', statusCode: 301 }] : []),
  ];
  if (nl.length > 1) fs.writeFileSync(path.join(OUT, 'public/_redirects'), nl.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'public/vercel.json'), JSON.stringify({ trailingSlash: true, ...(vRedirects.length ? { redirects: vRedirects } : {}) }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'vercel.json'), JSON.stringify({ outputDirectory: 'dist', trailingSlash: true, ...(vRedirects.length ? { redirects: vRedirects } : {}) }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'redirects.json'), JSON.stringify(redirects, null, 2) + '\n');
  step(`Mapped ${c.b(redirects.pairs.length)} old GitBook URLs${bp ? ` (${bp}/* → /*)` : ''}${redirects.exact.length ? `, ${redirects.exact.length} renamed page${redirects.exact.length > 1 ? 's' : ''}` : ''} for Vercel, Netlify and Cloudflare`);
}
const rep = [
  `# Migration report — ${siteTitle}`, '',
  `Source: ${base || dir} (pages discovered via ${disc.src})`,
  `Pages converted: ${report.pages} / ${disc.pages.length}`,
  `Images self-hosted: ${report.images}${report.imageFailures.length ? ` (${report.imageFailures.length} failed — still linked remotely)` : ''}`,
  ...(report.videos.length ? [`GIFs re-encoded to MP4: ${report.videos.length} (${(report.videos.reduce((a, v) => a + v.from, 0) / 1048576).toFixed(0)} MB → ${(report.videos.reduce((a, v) => a + v.to, 0) / 1048576).toFixed(1)} MB)`] : []),
  ...(smallGifs ? [`Small GIFs kept as GIFs (under ${GIF_MIN / 1048576} MB, --gif-mb to change): ${smallGifs}`] : []),
  ...(brand.hiddenGroups && brand.hiddenGroups.length ? [`Sections hidden from the sidebar (GitBook hides them too; pages still built): ${brand.hiddenGroups.join(', ')}`] : []),
  ...(brand.applied.length ? [`Branding copied from GitBook: ${brand.applied.join(', ')}`] : []),
  `Time: ${((Date.now() - t0) / 1000).toFixed(1)}s`, '',
  '## Needs a human look', '',
  ...(report.warnings.length ? report.warnings.map((w) => `- ${w}`) : ['- Nothing flagged.']),
  ...(report.oversize.length ? ['', `## Oversized media left on GitBook's CDN (> ${MAX_IMG / 1048576} MB)`, '', 'Re-encode these as MP4/WebM (10–50x smaller) and drop them in public/assets — otherwise they still depend on GitBook.', '', ...report.oversize.map((u) => `- ${u}`)] : []),
  ...(report.imageFailures.length ? ['', '## Images not downloaded', '', ...report.imageFailures.map((u) => `- ${u}`)] : []),
].join('\n');
fs.writeFileSync(path.join(OUT, 'MIGRATION_REPORT.md'), rep + '\n');
const flagged = report.warnings.length + report.oversize.length + report.imageFailures.length;
step(`Wrote ${c.b(path.relative(process.cwd(), OUT) || '.')} in ${((Date.now() - t0) / 1000).toFixed(1)}s ${flagged ? c.y(`(${flagged} items to review in MIGRATION_REPORT.md)`) : c.d('(nothing flagged)')}`);

// ---------- optional: install, build, check ----------
if (args.build) {
  const run = (cmd, a, opts = {}) => new Promise((res) => { const p = spawn(cmd, a, { cwd: OUT, stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: process.platform === 'win32' }); let out = ''; if (opts.quiet) { p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); } p.on('close', (code) => res({ code, out })); });
  if (!fs.existsSync(path.join(OUT, 'node_modules'))) {
    const local = path.join(HERE, 'template/node_modules');
    if (fs.existsSync(local)) fs.symlinkSync(local, path.join(OUT, 'node_modules'), 'dir');
    else { const r = await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { quiet: true }); if (r.code) { console.error(r.out); process.exit(1); } }
  }
  step('Dependencies ready');
  const tb = Date.now();
  const b = await run('npx', ['astro', 'build'], { quiet: true });
  if (b.code) { console.error(b.out.split('\n').filter((l) => /error|invalid|Location|mdoc|- /i.test(l)).join('\n')); console.error('Build failed — see above.'); process.exit(1); }
  step(`Built the static site in ${((Date.now() - tb) / 1000).toFixed(1)}s ${c.d('(dist/)')}`);
  const ck = await run('node', [path.join(HERE, 'check.mjs'), 'dist'], { quiet: true });
  if (redirects.pairs.length) {
    // apply the same wildcard rule the hosts use, then make sure every target is a real built page
    const bp = redirects.basePath;
    const apply = (p) => { const ex = (redirects.exact || []).find((x) => x.from === p); if (ex) return ex.to; return bp && (p === bp || p.startsWith(bp + '/')) ? p.slice(bp.length) || '/' : p; };
    const missing = redirects.pairs.filter(({ from }) => {
      const t = apply(from).replace(/\/?$/, '/');
      return !fs.existsSync(path.join(OUT, 'dist', decodeURIComponent(t), 'index.html'));
    });
    step(`Old URLs: ${redirects.pairs.length - missing.length}/${redirects.pairs.length} have a built target page${missing.length ? c.y(` — missing: ${missing.slice(0, 5).map((m) => m.from).join(', ')}`) : ''}`);
  }
  step(`Link check: ${ck.out.split('\n')[0]}`);
  console.log(`\n${c.b('Next')}: preview with ${c.b(`cd ${path.relative(process.cwd(), OUT)} && npx astro preview`)}, then deploy dist/ to Vercel, Netlify or Cloudflare Pages.`);
} else {
  console.log(`\n${c.b('Next')}: ${c.b(`cd ${path.relative(process.cwd(), OUT)} && npm install && npm run build`)} — or rerun with --build.`);
}
