# PAIGE Cloud — Monitoring, Logging, Recovery & Cost Visibility (F2)

## Monitoring (Coolify built-in, no new infra)
- Server health: Coolify get_infrastructure_overview (servers, counts, health hints).
- Application health: container healthcheck (Dockerfile HEALTHCHECK → /healthz), Coolify application status.
- Unhealthy resources: list_unhealthy_resources (sample_only for cost).
- Vulnerability scanning: get_vulnerabilities per image; manage_image_scanning to toggle.

## Logging
- Application logs: get_logs (resource=application, uuid) — Coolify aggregates container stdout/stderr.
- Deployment logs: get_deployment with include_log_summary; full build logs via Coolify UI.
- Server sentinel: is_sentinel_enabled (metrics, disk usage, patch checks) — configured on the server.

## Recovery procedures
- Rollback: rollback_application (to previous image tag) — limited by single "latest" tag for dockerfile builds; procedure documented in docs/05-rollback-runbook.md.
- Server unreachable: Coolify validate (re-check SSH/Docker); restart via control (start/stop/restart).
- Redeploy from source: deploy (rebuilds from Dockerfile).
- Restore from backup: manage_backup (database backups if/when databases added).

## Cost visibility
- Hostinger KVM 2: $13.99 first month, $24.49/mo renewal.
- Coolify Cloud: $5/mo (paid).
- Cloudflare: free tier (optional Pro $20/mo).
- Total: ~$19-29/mo vs Vercel $20-60/mo.
- Billing observations: Hostinger bills monthly; renewal auto-renews (owner to confirm in hPanel). No additional servers purchased under F2.

## Secure deployment permissions
- Coolify API token: read-restricted initially; write/deploy abilities granted only for deployment actions.
- Hostinger provider token: preserved, not modified.
- No production Vercel/Supabase/DNS access granted.
- Independent non-author review required for each deployment change (per AGENTS.md).

## Status
Implemented using existing Coolify built-in capabilities. No new infrastructure purchased. F2 scope.