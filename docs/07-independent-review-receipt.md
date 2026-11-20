# PAIGE Cloud — Independent Review Receipt

**Reviewer identity:** Independent non-author reviewer (subagent spawned by the delivery session; did not write the deployment artifacts). Not the author of any file under `paige-cloud-preview/`.

**Scope:** Nonproduction preview artifact set for the existing PAIGE Vite+React frontend (PAIGE Cloud F1 outcome). Read-only review of artifacts + live preview verification. No production Vercel/Supabase/DNS changes made or implied by this review.

**Head / version:**
- Artifact directory is not a git repository (no HEAD available). Reviewed file set as present on disk (10 files).
- Live preview build identity: `{"buildId":"dev-mwo0rpxa","customerUpdate":null}` (https://h0llaikzrfpua1ugygaadpjq.179.66.154.248.sslip.io).
- Live platform: nginx/1.27.5 behind HTTPS (sslip.io), HTTP->HTTPS 307.

**Inspected artifacts:**
- `README.md`
- `Dockerfile`
- `docker/nginx.conf`
- `docker-compose.yml`
- `docs/01-vercel-dependency-inventory.md`
- `docs/02-architecture.md`
- `docs/03-security-design.md`
- `docs/04-cost-comparison.md`
- `docs/05-rollback-runbook.md`
- `docs/06-vps-recommendation.md`

**Cross-reference checked:** `Paige-Agent-AI/vercel.json` (source of truth for rewrites/headers/cache). Lockfile name verified against source repo (`bun.lockb` present). Live preview exercised for healthz, version.json, sw.js, deep links, assets, headers, redirect.

---

## Findings

### PASS (no blocking issue)

1. **Dockerfile correctness (multi-stage, security, no secrets).** Multi-stage build (oven/bun:1.2-alpine build -> nginx:1.27-alpine serve), pinned base images, `bun install --frozen-lockfile` from `package.json`+`bun.lockb` (lockfile name matches source repo), HEALTHCHECK on /healthz, EXPOSE 80, no secrets/env baked into image, no Lovable references. PASS.

2. **nginx matches vercel.json.** Rewrites (/privacy, /sms-terms, /auth, SPA fallback), security headers (X-Content-Type-Options, Referrer-Policy, CSP), and cache rules (sw.js + entry html no-cache; /assets immutable 1y; version.json no-cache; embed.js 300s) mirrored. Live: deep links 200, assets Cache-Control `public, max-age=31536000, immutable`, sw.js no-cache, version.json no-cache + CSP. PASS.

3. **No Lovable code.** Artifact contains no Lovable code/assets; only an explicit "no Lovable" rule in security design. PASS.

4. **No production Vercel/Supabase/DNS changes implied.** Docs and compose labels scope to nonproduction preview; production Vercel/DNS/Supabase explicitly untouched; owner authorization gates provisioning. PASS.

5. **Cost comparison honesty.** Estimates labeled as estimates, evidence gaps section present, recommendation retains Vercel for production and requires measured cost + owner approval before any migration. PASS.

6. **Rollback runbook adequacy (preview scope).** Triggers, Coolify image rollback, source-level redeploy by commit SHA, post-rollback verification commands, and explicit non-goals (no prod DNS, no Supabase data change). Adequate for a preview. PASS (minor: no image-digest pinning or header re-verification step).

7. **Security.** No service-role key in image (Dockerfile contains none; only public anon key referenced in docs, consistent with frontend). Preview auth disabled/fixture mode documented. CSP present on live preview. PASS.

### Minor / non-blocking findings

- **M1 — `/healthz` duplicate Content-Type.** `location = /healthz` uses `add_header Content-Type text/plain;`, which adds a second Content-Type alongside nginx's default `application/octet-stream` (live shows both). Use `default_type text/plain;` instead. Also /healthz carries no security headers. Severity: low.

- **M2 — nginx `add_header` inheritance.** Security headers are defined only at server level, while several locations (healthz, html regex, sw.js, embed.js, assets, version.json) define their own `add_header`. Under standard nginx rules, a location with its own `add_header` does not inherit server-level headers. The live deployment nonetheless shows CSP/XCTO/Referrer on sw.js, assets, version.json, and index — indicating the deployed config was likely adjusted or uses an include. The artifact file as written is not self-evidently reproducible for those headers. Recommend making it explicit: repeat the security headers in each location or extract them to a shared include. Severity: medium-low (security posture, but live confirms headers present).

- **M3 — README status staleness.** README states "Live deployment: BLOCKED pending owner authorization..." while a live preview is deployed and verified. Update the Status section to reflect the deployed preview (and keep the "no production change" note). Severity: low.

- **M4 — Dockerfile not self-contained in this artifact.** `Dockerfile` expects the PAIGE repo as build context (`package.json`, `bun.lockb`, source). The artifact repo contains only docs + docker files, so `docker build` cannot run from this directory alone. Document the required build context (PAIGE repo root) or provide a build script. Severity: low (already hinted in README).

- **M5 — container runs as root (nginx default).** Security doc claims non-root "where possible"; nginx master runs as root by default. Acceptable for a preview on a trusted host, but the claim should be softened or a non-root variant added. Severity: low.

- **M6 — Coolify install via `curl | bash`.** VPS recommendation uses the official install script piped to bash. Standard practice, but recommend verifying the script/source and pinning. Severity: low.

- **M7 — healthcheck uses wget.** Fine for nginx:alpine (wget present). No change needed; noted for completeness.

### Not found / not applicable
- No service-role key, no secrets, no production hostnames, no Lovable code in any artifact.
- No automated tests in this artifact (static/docs only); live smoke checks substituted.

---

## Disposition

**APPROVE** — nonproduction preview artifact set is coherent, mirrors vercel.json, contains no secrets/Lovable code, makes no production changes, and the live preview verifies (healthz 200, deep links 200, CSP/XCTO/Referrer present, version.json present, sw.js no-cache, assets immutable 1y, HTTPS + HTTP->HTTPS redirect). Cost and rollback docs are adequate and honestly labeled.

**Conditions / recommended follow-ups (non-blocking):**
1. Fix M1 (duplicate Content-Type on /healthz) and harden M2 (explicit security headers per location) in `docker/nginx.conf`, then re-verify headers on all paths.
2. Update README Status (M3) to reflect the deployed preview.
3. Document the required Docker build context (M4).
4. Soften the non-root claim (M5) or add a non-root variant.

No material issue requires blocking merge/deployment. Re-review of `docker/nginx.conf` after M1/M2 fixes is recommended but not required before this preview remains live.