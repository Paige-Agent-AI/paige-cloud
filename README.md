# PAIGE Cloud — Nonproduction Preview (PAIGE frontend)

Independent PAIGE Cloud infrastructure artifact. Does NOT modify PAIGE's live Vercel deployment,
production DNS, Supabase data/credentials, or existing agents' source.

## Contents
- `Dockerfile` — multi-stage bun build + nginx serve
- `docker/nginx.conf` — rewrites/headers/cache mirroring vercel.json
- `docker-compose.yml` — Coolify/Docker Compose
- `docs/` — Vercel dependency inventory, architecture, security, cost comparison, rollback

## Build locally (verification only)
```
docker build -t paige-cloud-preview .
docker run --rm -p 8080:80 paige-cloud-preview
# then visit http://localhost:8080
```
Docker not available in this agent environment; build reproducibility verified via `npm run build`
on the PAIGE repo (dist/ produced, version.json present).

## Status
- Read-only inventory + design + build stack: COMPLETE (this artifact).
- Live deployment: DEPLOYED and verified on Hostinger KVM 2 / Coolify Cloud.
  Preview URL: https://h0llaikzrfpua1ugygaadpjq.179.66.154.248.sslip.io
- Independent non-author review: APPROVED (minor findings M1-M6; M1 fixed, M3 doc updated).
- No production change (Vercel/Supabase/DNS untouched).
