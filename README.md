# Unbook

**Leave GitBook. Keep your docs.** Unbook turns any public GitBook site into a self-hosted [Starlight](https://starlight.astro.build) (Astro) docs site in one command: static files you own, with search, dark mode, your logo and colours, and every old link redirected.

```bash
npx github:safwaankira/unbook https://docs.yourproject.xyz --build
```

```
✓ Copied logo, favicon, accent colour from the GitBook site
✓ Found 87 pages on https://docs.moonwell.fi/moonwell (via llms.txt)
✓ Converted 86 pages, self-hosted 245 images, turned 26 GIFs into MP4
✓ Mapped 87 old GitBook URLs (/moonwell/* → /*) for Vercel, Netlify and Cloudflare
✓ Built the static site in 4.0s (dist/)
✓ Old URLs: 87/87 have a built target page
```

Tested on five real GitBook sites (Moonwell, Curvance, Virtuals Protocol, Kintsu, Extra Finance — 358 pages). All build; every old URL redirects.

## What carries over

| GitBook | Becomes |
| --- | --- |
| Sidebar sections, nesting, hidden sections | Starlight sidebar with GitBook's own section names |
| Hints, tabs, expandables, steppers | Asides, tabs, titled asides, steps |
| Content-ref and card tables | Link cards and card grids |
| Code blocks (incl. HTML-exported highlighting) | Code blocks with titles and copy button |
| Tables (incl. links and code in cells) | Markdown tables |
| Images and file attachments | Downloaded into `public/assets` |
| Animated GIFs | Re-encoded to MP4, 10–50× smaller (needs ffmpeg) |
| Internal links, `/pages/<id>` links | Rewritten to the new paths |
| Old URLs | 301 redirects for Vercel, Netlify and Cloudflare Pages |
| Logo, favicon, brand colour | Copied from the live site |

Anything it can't convert cleanly is listed in `MIGRATION_REPORT.md`, and `--build` checks every link and image in the result.

## Options

```
--out <dir>          output folder (default: <name>-docs)
--build              install deps, build dist/, check links and redirects
--name <title>       site title (default: from the docs)
--site <url>         final docs URL, for the sitemap
--from <folder>      convert a GitBook Git Sync folder (SUMMARY.md) instead of a URL
--demo [note]        "unofficial preview" banner + noindex
--no-brand | --no-video | --no-images | --max-image-mb <n> | --gif-mb <n>
```

## Deploy

`dist/` is plain static files: put it on Vercel, Netlify or Cloudflare Pages and point your docs domain at it. The redirect files are already in place. Then switch off GitBook Git Sync and rotate any keys that lived in GitBook.

## Not yet supported

OpenAPI reference blocks (linked, not rendered), GitBook variants/versions, multiple languages, and private GitBook spaces (use `--from` with a Git Sync export instead). Issues and PRs welcome.

Requires Node 18+. MIT licensed. Not affiliated with GitBook.
