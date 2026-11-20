# PAIGE Cloud — VPS Recommendation (nonproduction preview)

## Recommendation (economical, qualified)
- Provider: Hetzner Cloud (EU/US), CPX21 (3 vCPU AMD, 4 GB RAM, 80 GB NVMe SSD) — ~$8.50/mo (EU) / ~$12 (US).
- Region: ash (Ashburn, US-East) for proximity to Supabase (US) and owner; or nbg1/fsn1 (EU) if EU data preferred. Owner choice.
- Storage: 80 GB included; add Volume 20 GB (~$1/mo) only if build cache/logs need persistence.
- Backups: Hetzner automated backups +$1.70/mo (20% of instance) — recommended.
- OS: Ubuntu 24.04 LTS.
- SSH: key-based only, ed25519, owner-held private key; disable password auth; UFW allow 22/80/443; fail2ban optional.

## Coolify connection
- Install Coolify (self-hosted) on the VPS via official install script (curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash) — requires root, ~5 min.
- Coolify Cloud ($5/mo) can manage the self-hosted instance via the Coolify Cloud connector, OR self-hosted Coolify alone is free. Since owner already paid $5 Coolify Cloud, use Coolify Cloud to manage the VPS instance (managed control plane, app stays on owner VPS).
- Deploy method: Git-based (Coolify pulls repo, builds Dockerfile) OR pre-built image push. For preview, Git-based from a read-only clone of Paige-Agent-AI is simplest; or build image locally/CI and push to a registry. Given no local Docker, use Coolify's built-in Dockerfile build on the VPS (Coolify has Docker on the host).

## Estimated monthly total
- VPS CPX21: $8.50-12
- Backups: $1.70-2.40
- Coolify Cloud: $5.00 (already paid)
- Cloudflare (free tier): $0 (optional Pro $20)
- Total: ~$15-19/mo. Well under Vercel $20-60/mo, with full ownership.

## Owner-controlled remaining actions
1. Provide COOLIFY_CLOUD_TOKEN (or self-hosted Coolify admin) securely via env var — never in chat/commit.
2. Authorize VPS creation + budget.
3. Choose region and preview auth mode (disabled/fixture recommended for first preview).
4. (Optional) Cloudflare zone for preview hostname.

## Supabase safety for preview
- Preview uses only the public Supabase publishable (anon) key (already public in frontend). No service-role key in image.
- To avoid unintended production side effects: run preview with auth DISABLED or a dedicated non-production Supabase project for the first pass; if reusing production Supabase, add the preview origin to the auth redirect allowlist (owner-authorized, non-destructive) and restrict to read-only fixture tenants. Do NOT run preview against production with live mutation capabilities enabled.
- No Supabase migrations, RLS, or data changes. No production redirect/callback changes without separate authorization.
