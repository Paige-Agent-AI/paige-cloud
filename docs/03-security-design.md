# PAIGE Cloud — Security Design (nonproduction preview)

## Principles
- Production Vercel deployment, production DNS, Supabase data/credentials, and existing agents' source are NOT modified.
- No secret export/copy. Preview uses only public Supabase publishable (anon) key, same as production frontend (public by design).
- Preview is nonproduction: distinct hostname (e.g. preview.paige... or a host-provided subdomain), no production domain transfer.
- Least privilege: Coolify admin access owner-only; container runs as non-root where possible (nginx base image default); no SSH keys in image.

## Headers (mirrored from vercel.json)
- X-Content-Type-Options: nosniff
- Referrer-Policy: strict-origin-when-cross-origin
- Content-Security-Policy (as in vercel.json)
- Cache-Control per path (sw.js, entry html no-cache; assets immutable 1y).

## TLS
- Let's Encrypt via Coolify/Traefik OR Cloudflare origin cert. HTTPS only; HSTS optional for preview (not production).

## Auth/CORS/OAuth (preview)
- If preview auth is exercised: add preview origin to Supabase Auth redirect allowlist (owner-authorized, non-production config). Otherwise preview runs with auth disabled / fixture mode.
- No production callback URLs changed.
- CORS: Supabase already allows browser origins; preview origin added only if needed.

## Supply chain
- Pinned base images (oven/bun:1.2-alpine, nginx:1.27-alpine).
- Frozen lockfile install (bun install --frozen-lockfile).
- No Lovable code/assets (owner rule).

## Data
- No Supabase data changes. No migrations. No RLS changes.
- Container is stateless; no persistent volume for user data.

## Open risks
- CSP is permissive (unsafe-inline/unsafe-eval) inherited from Vercel; tighten later as separate hardening outcome.
- No WAF beyond Cloudflare optional.
