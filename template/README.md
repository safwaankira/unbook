# __TITLE__

Self-hosted docs, migrated off GitBook. Built with [Starlight](https://starlight.astro.build) (Astro) — static HTML, built-in search, dark mode, no per-seat fees and no third-party service holding your content or secrets.

## Edit
Pages live in `src/content/docs/` as Markdoc (`.mdoc`) — plain Markdown plus `{% aside %}`, `{% tabs %}`, `{% linkcard %}` blocks. The sidebar is in `astro.config.mjs`.

## Run locally
    npm install
    npm run dev

## Deploy (free)
- **Vercel / Netlify / Cloudflare Pages:** import the repo, build command `npm run build`, output `dist`.
- Point your docs domain's CNAME at the host. Done.

See `MIGRATION_REPORT.md` for anything that needed a human look.
