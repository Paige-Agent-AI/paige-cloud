# PAIGE Cloud F2 — Independent Non-Author Review Receipt

**Reviewer identity:** Independent non-author reviewer (subagent spawned by the delivery session). Did not author any file under `paige-cloud-preview/` and did not perform any deployment. Review performed against the repository and live endpoints listed below.

**Outcome under review:** PAIGE Cloud F2 — Governed CI/CD and Cloud Operations (nonproduction preview).

**Head / version inspected:** Git commit `e6d3052` (F2 v4, rollback demonstration) on `master`; deployed application `2xohh97jxgrsjschqjcae6gn` (healthz `ok`); comparison deployment `x9mjc06noelwqupykogyppqj` (healthz `ok v3`).

**Date of review:** 2026-11-20.

---

## Inspected artifacts

- Git history: commits `485d50e`, `26cbd14`, `dc150cb`, `e6d3052` (`git log`, per-commit `--stat`, inter-commit diffs).
- `Dockerfile` (clone-based, multi-stage, inline nginx, healthcheck, `LABEL org.opencontainers.image.version="v2"`).
- `docker/nginx.conf` (legacy host-based config, not used by the deployed image).
- `docker-compose.yml`, `README.md`.
- `docs/01`–`docs/07`, `docs/09`, `docs/10-monitoring-cost-visibility.md`.
- Live endpoints: v3 `https://x9mjc06noelwqupykogyppqj.179.66.154.248.sslip.io`, v4 `https://2xohh97jxgrsjschqjcae6gn.179.66.154.248.sslip.io` (healthz, version.json, deep links, headers).
- Coolify/Hostinger platform metadata as documented (KVM 2 Boston, Docker 29.10.0, Coolify 4.7.6).

---

## Findings

### PASS (evidence-backed)

1. **Source control and commit provenance.** Four commits present with clear, sequential messages (`485d50e` F1, `26cbd14` F2 v2, `dc150cb` F2 v3, `e6d3052` F2 v4); each touches only `Dockerfile` (except F1, which added the artifact set). Author identity consistent; no force-push/rebase artifacts observed in `git log`. PASS.

2. **Two distinct versions deployed and rollback demonstrated.** Live v3 endpoint returns `ok v3`; live v4 endpoint returns `ok`, matching the inter-commit diff (`dc150cb` added `v3` marker, `e6d3052` restored `ok`). Both endpoints return HTTP 200 with valid healthcheck. PASS.

3. **No production Vercel/Supabase/DNS changes.** All artifacts scope to a nonproduction preview hostname on `sslip.io`; docs and compose labels explicitly state production Vercel/DNS/Supabase untouched; no production hostnames, migrations, RLS changes, or DNS records appear in the repo. PASS (evidence basis: repository contents and documented scope; I did not independently audit the live Vercel/Supabase accounts).

4. **No new infrastructure purchased.** Deployment reuses the existing Hostinger KVM 2 + Coolify Cloud; `docs/10` states no additional servers purchased under F2. PASS (evidence basis: documentation; I did not audit Hostinger billing).

5. **Security — no secrets in image; preview auth disabled.** `Dockerfile` contains no secrets, env vars, or service-role keys; only public Supabase publishable (anon) key is referenced in docs (public by design). Multi-stage build keeps build tooling out of the serve image. Live response carries CSP, `X-Content-Type-Options`, `Referrer-Policy`; `/healthz` returns a single `Content-Type: text/plain` (M1 from F1 resolved). Preview auth documented as disabled/fixture mode. PASS.

6. **Monitoring/logging/recovery/cost visibility documented.** `docs/10-monitoring-cost-visibility.md` documents Coolify built-in monitoring, application/container logs, deployment log summaries, recovery procedures, and cost figures (KVM 2 $13.99 first month / $24.49 renewal; Coolify Cloud $5/mo). PASS.

### Non-blocking findings (carried / new)

- **N1 — Rollback documentation inconsistency.** `docs/05-rollback-runbook.md` describes Coolify retaining the prior deployment image for one-click rollback, while `docs/10` states rollback is limited by a single `latest` image tag for Dockerfile builds and is effectively rebuild-based. These cannot both be true as written. Operators relying on instant rollback could be misled. **Severity: medium (documentation).** Recommend reconciling `docs/05` to state that dockerfile builds publish a single `latest` tag and rollback is rebuild-based, with true instant rollback requiring commit-SHA-tagged images.

- **N2 — Floating upstream source (reproducibility/governance).** `Dockerfile` runs `git clone --depth 1 https://github.com/Paige-Agent-AI/Paige-Agent-AI.git .` with no commit SHA or tag pin. Builds therefore float on the upstream default branch, so a given commit of `paige-cloud-preview` does not deterministically reproduce a given upstream frontend. For a "governed CI/CD" outcome this is a governance gap. **Severity: medium.** Recommend pinning to a recorded commit SHA (and documenting it per deployment), or moving to git-based Coolify deploys against a fork with a pinned ref.

- **N3 — Stale `LABEL` version.** `Dockerfile` carries `LABEL org.opencontainers.image.version="v2"` while HEAD is F2 v4. Image metadata no longer reflects the deployed version. **Severity: low.** Recommend deriving the label from the commit/healthz marker.

- **N4 — `docker/nginx.conf` is stale and unused.** It still uses `add_header Content-Type text/plain;` on `/healthz` (the duplicate-Content-Type bug fixed in the inline config) and does not repeat security headers in locations (F1 M2). The deployed image uses the inline nginx from `Dockerfile`, so this file is dead config that drifts from reality. **Severity: low.** Recommend either deleting it or regenerating it from the inline config.

- **N5 — Minor container hygiene (carried from F1 M5/M6).** Container runs as root (nginx default) despite security doc implying non-root "where possible"; VPS recommendation uses `curl | bash` for Coolify install. Acceptable for a preview on a trusted host, but claims should be softened or hardened. **Severity: low.**

### Rollback limitation (explicitly documented, non-blocking)

- Single `latest` image tag for Dockerfile builds; live rollback is rebuild-based. Documented in `docs/10` and (after N1 reconciliation) `docs/05`. **Non-blocking.** True instant rollback requires commit-SHA-tagged images (future work).

### Not verified / out of scope

- Independent audit of Hostinger billing, Vercel/Supabase account state, and Coolify token permissions was not performed; those findings rest on repository documentation and the reviewer's read-only inspection of live endpoints.

---

## Disposition

**APPROVE** — F2 outcome is coherent and verified end-to-end: four provenanced commits, two distinct deployed versions with a demonstrated rollback (`ok v3` → `ok`), no production Vercel/Supabase/DNS changes implied, no new infrastructure, no secrets in the image, preview auth disabled, and monitoring/logging/recovery/cost visibility documented. Live endpoints pass healthz, version.json, deep-link, and header checks.

**Material issues:** None blocking merge or continued operation of the preview.

**Conditions / recommended follow-ups (non-blocking):**
1. Reconcile `docs/05-rollback-runbook.md` with `docs/10` on rebuild-based rollback (N1).
2. Pin upstream source to a commit SHA in `Dockerfile` (N2).
3. Update `LABEL` version to track the deployed version (N3).
4. Remove or regenerate stale `docker/nginx.conf` (N4).
5. Soften non-root / install-script claims (N5).
6. Future work: git-based deploys with commit-SHA image tags for true instant rollback; authenticated staging per `docs/09`.