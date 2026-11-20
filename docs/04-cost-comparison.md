# PAIGE Cloud — Fully Loaded Cost Comparison (estimates, evidence-based)

## Baseline: Vercel (current)
- Vercel Pro: ~$20/user/mo + usage (bandwidth, build minutes, serverless). For a static SPA with moderate traffic, likely $20-60/mo.
- Includes: CDN, TLS, preview deployments, rollback, build infra, zero ops.
- Hidden costs: vendor lock-in for routing/headers; limited control over host; per-seat pricing scales.

## Option A: Coolify on a single VPS (preferred candidate)
- VPS (e.g. Hetzner CPX21: 3 vCPU/4GB): ~$8-12/mo. Storage/backup +$2-5/mo.
- Cloudflare: free tier (DNS + proxy + basic WAF) sufficient for preview; Pro $20/mo if advanced WAF needed.
- Domain: existing; preview subdomain no extra cost.
- Ops labor: initial setup 4-8h; ongoing ~2-4h/mo (updates, cert renewal mostly automated).
- Total estimate: $10-35/mo infra + ops labor. ~$120-420/yr infra.

## Option B: Docker on VPS without Coolify (manual)
- Same infra cost; higher ops labor (manual compose, cert, rollback). Not recommended unless Coolify disqualified.

## Option C: AWS (ECS/Fargate or EC2)
- Higher base cost ($30-80/mo) + complexity; not justified for static SPA. Listed for completeness; not recommended.

## Comparison summary
| Dimension | Vercel | Coolify/VPS | Manual Docker | AWS |
|---|---|---|---|---|
| Monthly infra (est) | $20-60 | $10-35 | $10-35 | $30-80 |
| Ops labor | very low | low | medium | high |
| Control/ownership | low | high | high | high |
| Rollback | built-in | image-based | manual | complex |
| TLS/CDN | built-in | Let's Encrypt + CF | manual + CF | ALB+CF |
| Vendor lock-in | medium | low | low | medium |

## Recommendation
- Keep Vercel for production now (zero-risk, low ops).
- Stand up Coolify preview on a small VPS to validate parity and ops cost.
- Re-evaluate production migration only after: (a) preview parity proven, (b) ops runbook tested including rollback, (c) measured cost over >=1 month, (d) owner approval. No automatic migration.
- Do NOT spend/provision until owner authorizes host account and budget.

## Evidence gaps
- No real host provisioned (no authorization). All costs are estimates from public pricing; must be re-measured on actual invoice.
- No load/availability measurement yet.
