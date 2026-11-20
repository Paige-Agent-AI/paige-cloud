# PAIGE Cloud — Rollback Runbook (preview)

## Triggers
- Preview fails smoke checks (deep links, CSP, version.json, sw.js).
- Security finding in image/headers.
- Cost/ops exceeds threshold.

## Rollback steps (Coolify)
1. Coolify UI -> Application -> Deployments -> select previous deployment -> "Redeploy"/Rollback.
2. Verify /healthz 200 and /version.json buildId matches prior.
3. If DNS changed (it should not have for preview host): revert preview hostname record.
4. Remove preview origin from Supabase auth allowlist if added (owner-authorized action).

## Source-level rollback
- Redeploy prior git commit SHA via Coolify "Redeploy with commit".

## Verification after rollback
- curl https://<preview>/healthz -> 200
- curl https://<preview>/version.json -> prior buildId
- Deep links /privacy, /sms-terms, /auth, /some/deep/path -> 200/SPA
- Production Vercel untouched (verify paigeagent.ai still serves).

## Non-goals
- No production DNS change. No Supabase data change.
