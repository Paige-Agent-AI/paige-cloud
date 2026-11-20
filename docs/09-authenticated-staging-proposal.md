# PAIGE Cloud — Authenticated Staging Proposal (separate, owner-gated)

This is a PROPOSAL only. Not implemented under F2. Requires separate owner authorization.

## Goal
Enable authenticated preview of the PAIGE frontend against a non-production Supabase project, so login flows can be tested without touching production auth/data.

## Approach
1. Create a dedicated Supabase project (non-production) for staging, or use a separate schema/branch in the existing project if Supabase branching is available.
2. Configure the staging frontend build with the staging Supabase URL + publishable key (via Coolify env vars, not baked into image).
3. Add the staging preview origin to the staging Supabase auth redirect allowlist (not production).
4. Use isolated test accounts (no real customer data). Seed via Supabase SQL (owner-authorized, non-production only).
5. Deploy a separate Coolify application "paige-web-staging" pointing at the same Dockerfile but with staging env vars.
6. HTTPS via Coolify Let's Encrypt on a staging subdomain.

## Safety constraints
- Production Supabase project untouched (no redirect changes, no data, no RLS changes).
- No production DNS changes.
- No real customer accounts or data in staging.
- Preview auth disabled by default; staging auth opt-in per deployment.

## Cost
- Reuses existing Hostinger KVM 2 + Coolify Cloud (no new server). Staging app runs alongside preview app on the same server.
- Estimated additional: $0 infra (same server), minor memory/CPU overhead.

## Owner decisions needed
- Approve creation of a non-production Supabase project (or branch).
- Approve staging env var configuration in Coolify.
- Approve test account seeding (non-production only).

## Status: PROPOSAL — not implemented. Awaiting separate authorization.