# PAIGE Cloud — Vercel Dependency Inventory (read-only)

Source: `Paige-Agent-AI` repo (origin https://github.com/Paige-Agent-AI/Paige-Agent-AI.git), commit inspected locally.
Build: Vite + React + shadcn/ui (package name `vite_react_shadcn_ts`), install via bun, output `dist/`.

## Build & static entry points
- Scripts: `dev` (vite), `build` (vite build), `preview` (vite preview), `build:dev`.
- Multi-entry Rollup inputs: `index.html`, `privacy.html`, `sms-terms.html`, `auth.html`.
- Output dir: `dist` (default). `version.json` written at build time with `{ buildId, customerUpdate }` by vite plugin (see vite.config.ts ~65).
- Manual chunks: react-vendor, query-vendor, ui-vendor, chart-vendor, paige-command-mark.

## Vercel routing (vercel.json)
- ignoreCommand: `bash scripts/vercel-ignore.sh`
- installCommand: `bun install`
- Rewrites:
  - /privacy -> /privacy.html
  - /sms-terms -> /sms-terms.html
  - /auth -> /auth.html
  - /((?!assets/).*) -> /index.html (SPA fallback)
- Headers (all paths): X-Content-Type-Options nosniff; Referrer-Policy strict-origin-when-cross-origin; CSP (permissive: default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; ...).
- Cache: sw.js no-cache; privacy/sms-terms/auth html no-cache; index.html no-cache; embed.js public max-age 300.

## Supabase dependency (frontend)
- Frontend uses Supabase client (auth, database, edge functions). Env vars referenced at build/runtime: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY (and possibly VITE_SUPABASE_ANON_KEY). Exact keys not probed (no secret export).
- OAuth callback allowlists and CORS on Supabase side must include the new preview origin if preview auth is exercised. Preview auth uses non-sensitive fixture/authorized config only.

## Vercel-specific / server-side dependencies
- No Vercel serverless functions in this repo's frontend tree (functions live in Supabase edge functions). vercel.json has no `functions` key.
- Cron: none defined in vercel.json.
- No Vercel KV/Blob/Edge Config references found in frontend build config.

## Static assets / PWA
- sw.js present (service worker) — cache behavior must be preserved.
- public/ assets copied to dist.

## Conclusion
The frontend is a pure static SPA build. Vercel's only roles are: build (bun install + vite build), static hosting, rewrites, headers, cache. All can be reproduced with Docker + nginx. Supabase remains the backend/auth dependency and is unchanged.
