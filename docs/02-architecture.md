# PAIGE Cloud — Architecture (nonproduction preview)

## Goal
One real, owner-visible nonproduction hosting preview of the EXISTING PAIGE Vite+React frontend, outside Vercel, with Vercel production and Supabase unchanged.

## Components
1. Source: GitHub repo Paige-Agent-AI/Paige-Agent-AI (read-only clone for build).
2. Build: oven/bun + vite build (multi-entry). Reproducible via Dockerfile.
3. Serve: nginx 1.27 (static, rewrites, headers, cache) in container.
4. Host: owner-approved Linux VPS (Coolify-managed) OR any Docker-capable Linux host. TBD pending authorization.
5. Edge/CDN (optional): Cloudflare DNS + proxy + WAF + TLS. TBD pending authorization.
6. Backend: existing Supabase project (unchanged). Preview origin added to Supabase auth redirect allowlist only if preview auth exercised (owner-authorized, non-production).

## Network flow
Browser -> (Cloudflare, optional) -> host:443 (TLS) -> Coolify/Traefik -> container:80 (nginx) -> static files.
Auth/API calls from browser -> Supabase (existing) directly (CORS/redirect config).

## Coolify fit
- Coolify = open-source self-hosted PaaS (Docker-based) supporting Dockerfile/Compose deployments, TLS via Let's Encrypt, Git-based deploys, rollback to prior image.
- Preferred starting candidate per charter; not permanently mandated.
- Requires a Linux host with Docker + Coolify installed; owner-approved spend/account.

## Rollback
- Coolify keeps prior deployment image; one-click rollback to previous image.
- DNS/origin rollback: revert preview hostname to previous or remove; production DNS untouched.
- Source rollback: redeploy prior git commit SHA.

## What is NOT in scope (this outcome)
- Production cutover, DNS transfer, Supabase migration, customer hosting, long-running workers, control panel.
