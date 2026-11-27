# PAIGE Cloud — Fully Loaded Cost Comparison (estimates, evidence-based)

## Cloud-first, reuse-first AWS intelligence and economics

**Decision.** Prioritize PAIGE-owned DevOps on AWS primitives. Run routine work deterministically, add canonical Model Fabric inference only for measured improvement, and qualify AWS specialists selectively. Cloud owns infrastructure services while PAIGE Agent AI's existing source and tests supply reusable IP and compatibility evidence. Original owners retain the shared intelligence and business Experiences. No new service activation, inference provider, or spending follows from this assessment. The $150/month gross development envelope remains controlling.

### Foundation and ownership

Reviewed [PAIGE Agent AI `79e2f303`](https://github.com/Paige-Agent-AI/Paige-Agent-AI/tree/79e2f303e41662af2a8e7c3027ec4189127727d5). Inspectable foundations include Trust's `workspace-authority.ts` and MCP authority; Spine's pure `governedExecution.ts` and `action-risk.ts`; the Work/Harness durable envelope migration `20270417000000_paige_durable_work_envelope.sql`; the single Orchestration claim in `paige-orchestration/dispatch-claim.ts`; Vault custody; Rail's `mcp-gateway/rail-receipt.ts`; native MCP, Action Bus effects, Model Fabric, session memory, and the Intelligence gate at `eval/gate.ts`. Use their authority, execution, knowledge/skills, and evidence semantics. The Cloud observation adapter packages the original Spine decision and supplies verified Cognito and PostgreSQL scope. Cloud actor and Agent AI tenant IDs require an explicit mapping before any cross-product delegation. Existing ownership and all BR/GR anchors remain in [ANT-147](https://linear.app/paigeagentai/issue/ANT-147) and the [Cloud architecture record](02-architecture.md).

### Candidate decisions

Effort is a planning range in engineer-days for a bounded first integration and maintenance days per month in parentheses. For illustration use $600/engineer-day in internal development expense. Hosted engines trade some initial engineering for recurring rates, contract dependency and integration ownership. Only the PAIGE Lambda inspection has live comparative baseline evidence. Hypothetical costs below exclude free tiers, credits and temporary discounts.

| Candidate / original PAIGE owner | AWS-managed option and public gross rate | PAIGE-owned, hybrid and open-source options | Recommendation and effort |
| --- | --- | --- | --- |
| AgentCore Runtime v1/v2 / Work, Harness, Orchestration | MicroVM v1 $0.0895/vCPU-h and $0.00945/GB-h. v2 on-demand $0.1276 and $0.0169. Idle session memory, storage and egress can accrue cost. Managed instances add a fee to EC2 (AWS example 12%). | PAIGE Work leases on Lambda for short deterministic tasks, ECS/Fargate for longer jobs and ECS/EC2 when measured saturation warrants. Firecracker is a possible Apache-2.0 isolation primitive with substantial host hardening and support. | Adopt Lambda, adapt Fargate where warranted, defer AgentCore. Managed adapter 5–12 (1–3); qualified owned leased fleet 25–60 (4–10). |
| AgentCore Browser / Cloud, Trust, Skills | $0.0895/vCPU-h and $0.00945/GB-h. A 45s, 1 vCPU/0.75 GB session is $0.00121 before recording, data and egress. | Owned browser capability on isolated Fargate with Playwright (Apache-2.0) is a lower-cost comparator. Bound target access, session credentials, evidence retention, time and network egress. A browser process alone is insufficient tenant isolation. | Defer managed Browser until a matched task warrants it. Managed wrapper 8–20 (2–5); isolated worker 20–45 (4–10). |
| AgentCore Code Interpreter / Work, Harness, Vault | Same active CPU/memory rates. 20s at 0.5 vCPU/0.5 GB is $0.000275 before data and logs. | Use deterministic Lambda for approved functions. Unknown code requires disposable workers, qualified sandbox isolation, output and filesystem bounds, dependency review, and egress restrictions. Evaluate Fargate/EC2 and vetted open-source tooling then. | Adopt deterministic functions now. Defer arbitrary-code service. Managed wrapper 8–20 (2–5); owned sandbox 25–60 (4–12). |
| AgentCore Gateway / native MCP, Spine, Vault | $0.005/1k invokes, $0.025/1k searches, $0.02/100 indexed tools per month, plus connected tools and optional Policy. | Preserve PAIGE's endpoint grants, token custody and receipts. Consider an AWS adapter behind existing MCP. Open MCP SDK is transport, with authority still in Trust. | Reject replacement; defer a narrow adapter, 5–12 (1–3). |
| AgentCore Harness / Work, Harness, Orchestration | Meter underlying Runtime, inference, memory and tools. Managed Harness owns parts of the agent loop. | Keep PAIGE's Work envelope, grant, execution fence and unknown-effect reconciliation. Step Functions can run provider plumbing under an existing lease. Strands could supply SDK utilities without owning orchestration. | Reject as PAIGE Harness; selective provider integration 8–20 (2–4) if justified. |
| AgentCore Memory / Knowledge, Memory, Vault | Short-term $1/GB ingest, $0.20/GB retrieved and $0.10/GB-month. Built-in long-term $0.75/1k records-month and $0.50/1k retrievals. | Keep scope, record ACL and extraction Work under original owners. PostgreSQL/S3 are replaceable infrastructure. Preserve revocation, deletion, provenance and restore. | Defer managed memory. Scoped owned extension 10–25 (2–5). |
| AgentCore Identity and Policy / Trust, Vault | Identity $0.010/1k separately billed non-AWS credential requests. Policy $0.000025/authorization and $0.13/1k tokens where applicable. | IAM, Cognito, KMS and Secrets Manager serve existing authority. Cedar is a possible policy primitive only with original Trust conformance, scope and expiry proof. | Adopt primitives, reject Trust/Vault replacement. Narrow policy integration 6–18 (1–4). |
| AgentCore Evaluations / Intelligence, Model Fabric | Built-in online evals $2.40/M input and $12/M output tokens. Custom $1.50/1k plus model charges. | Use owner-controlled evaluation over typed deterministic evidence. OpenTelemetry can provide portable telemetry. An offline comparator can add evidence without taking ownership. | Adopt native verification, defer managed evals. Comparator 6–16 (1–4). |
| AWS DevOps Agent / Cloud, Trust, Work, Intelligence | $0.0083 active agent-second ($29.88/h). Eight minutes is $3.984 plus telemetry, with cumulative charges for parallel activity. | Build native scoped observations and deterministic diagnosis from release, CloudWatch and recovery evidence. Extend through original Work and PAIGE Intelligence; compare escalation only for unresolved cases. | Prioritize hybrid PAIGE-owned DevOps. First diagnostics 10–25 (2–6). Defer optional engineering-only specialist, adapter 5–15 (1–3). |
| AWS Security Agent / Continuum / Trust, Secure, Intelligence | Penetration-test tariff $50/task-hour and minimum selectable cap 20 hours, up to $1,000 gross exposure at the smallest cap. Preview design and code review lack durable post-preview prices. | Apply passive IAM/source/dependency assessment and existing evidence ownership. Trivy and CodeQL are safety-review candidates with applicable license checks. Independent qualified human review remains appropriate for material risks. | Reject for this pilot and as always-on COGS. Owned passive controls 8–20 (2–5). |
| AWS Transform / original source and release owners | Custom $0.035/agent-minute. 20 active minutes is $0.70; 2,800 would be $98 at custom rate. Builds, revalidation and migration effects are additional. | Use codemods such as jscodeshift, test budgets, independent review, and exact immutable rollback under original owners. An AWS specialist can be assessed for one-off modernization. | Defer to specifically authorized internal jobs. Codemod contract 5–15 (1–3). |
| Agent Toolkit, Skills and AWS MCP / Skills, native MCP, Cloud | Toolkit lists no separate charge. Authenticated tools still incur AWS resource and inference usage. | Adopt primary docs and qualified versioned engineering skills. Use direct scoped SDK reads for product operations. Source review and applicable licensing precede redistributing skills. | Adopt engineering references; defer connected AWS MCP in the product. Engineering bundle 2–6 (1–2). |

**Compute sensitivities.** Ohio Lambda Arm base $0.0000133334/GB-s and $0.20/M invokes; 128 MiB for 0.843 seconds averages $0.00000161 including request. Fargate Arm Ohio $0.03238/vCPU-h plus $0.00356/GB-h; a 1 vCPU/2 GB task billed one minute is $0.000658 and a 0.5 vCPU/1 GB task is $0.000329. Include pull time, log/egress and warm capacity. Ohio EC2 `t4g.small` $0.0168/h or $12.26/730 h before EBS, network, redundancy and maintenance. Step Functions Standard worked-example price $0.000025/transition or $0.00015 for six steps; verify regional rates at purchase. Express has a different request/duration and delivery model. Use AWS SDK, CloudWatch, PostgreSQL, S3, IAM, Cognito and KMS as technical primitives, not additional intelligence engines.

Public sources and Ohio Price List cross-checks: [AgentCore rates](https://aws.amazon.com/bedrock/agentcore/pricing/) · [AgentCore Harness metering](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-operations.html) · [AgentCore regional matrix](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html) · [AWS DevOps](https://aws.amazon.com/devops-agent/pricing/) · [Continuum](https://aws.amazon.com/continuum/pricing/) · [Transform](https://aws.amazon.com/transform/pricing/) · [Toolkit](https://docs.aws.amazon.com/agent-toolkit/latest/userguide/what-is-agent-toolkit.html) · [Lambda](https://aws.amazon.com/lambda/pricing/) · [Fargate](https://aws.amazon.com/fargate/pricing/) · [Step Functions](https://aws.amazon.com/step-functions/pricing/).

### Gross monthly scenarios

Assumptions for a prelaunch sensitivity analysis. No price or forecast has been adopted. Plan token sensitivity is 2,000 input and 500 output tokens at $0.80/M and $3.20/M respectively, or $0.0032 per attempt. Model routing stays with Model Fabric. Attempts capture failed runs, retries and parallel activity; a valid outcome needs independent evidence.

| Scenario | Inspections / plans / browser / code / specialist incidents per active customer | Attempts / verified success | Storage / logs / egress GB | Support and recovery reserve/customer |
| --- | --- | --- | --- | --- |
| Light | 40 / 1 / 0 / 0 / 0.01 | 1.03× / 99% | 0.2 / 0.02 / 0.02 | $0.05 |
| Typical | 240 / 12 / 4 / 3 / 0.05 | 1.12× / 98% | 1 / 0.12 / 0.20 | $0.15 |
| Heavy | 1,200 / 48 / 24 / 24 / 0.20 | 1.30× / 95% | 5 / 0.60 / 1 | $0.45 |
| Peak | 3,600 / 150 / 90 / 72 / 0.50 | 1.65× / 90% | 15 / 2.4 / 4 | $1.50 |

Marginal = attempts × (inspections × $0.000012 + plans × ($0.00010 infrastructure + $0.00320 inference) + browser × $0.00066 + code × $0.00036) + storage GB × $0.023 + log GB × $0.50 + egress GB × $0.09. The per-inspection and plan infrastructure add-ons are scenario inputs, including request/data work, pending end-to-end metering. Shared costs are modeled ($84/$200/$850/$5,800) for writer capacity, idle serving capacity, HA/recovery and shared network. Support at $90/h gives $0.15 per customer for 10 minutes per 100 customers. Additional maintenance, labor, tax, payments and company overhead need finance inputs before a price or margin claim.

| Active customers | Usage | Marginal | Shared AWS | Support/recovery | Owned/hybrid COGS | $/verified outcome | Selective AWS DevOps add-on | AWS DevOps for every plan |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Light | 0.02 | 84.00 | 0.05 | 84.07 | 2.07121 | 0.05 | 4.10 |
| 1 | Typical | 0.15 | 84.00 | 0.15 | 84.30 | 0.34136 | 0.25 | 53.54 |
| 1 | Heavy | 0.76 | 84.00 | 0.45 | 85.21 | 0.07187 | 1.00 | 248.60 |
| 1 | Peak | 2.93 | 84.00 | 1.50 | 88.43 | 0.02620 | 2.49 | 986.04 |
| 100 | Light | 2.03 | 200.00 | 5.00 | 207.03 | 0.05101 | 4.98 | 410.35 |
| 100 | Typical | 15.27 | 200.00 | 15.00 | 230.27 | 0.00932 | 24.90 | 5,354.50 |
| 100 | Heavy | 76.15 | 200.00 | 45.00 | 321.15 | 0.00271 | 99.60 | 24,860.16 |
| 100 | Peak | 293.38 | 200.00 | 150.00 | 643.38 | 0.00191 | 249.00 | 98,604.00 |
| 1,000 | Light | 20.29 | 850.00 | 50.00 | 920.29 | 0.02267 | 49.80 | 4,103.52 |
| 1,000 | Typical | 152.74 | 850.00 | 150.00 | 1,152.74 | 0.00467 | 249.00 | 53,544.96 |
| 1,000 | Heavy | 761.46 | 850.00 | 450.00 | 2,061.46 | 0.00174 | 996.00 | 248,601.60 |
| 1,000 | Peak | 2,933.81 | 850.00 | 1,500.00 | 5,283.81 | 0.00157 | 2,490.00 | 986,040.00 |
| 10,000 | Light | 202.93 | 5,800.00 | 500.00 | 6,502.93 | 0.01602 | 498.00 | 41,035.20 |
| 10,000 | Typical | 1,527.44 | 5,800.00 | 1,500.00 | 8,827.44 | 0.00357 | 2,490.00 | 535,449.60 |
| 10,000 | Heavy | 7,614.64 | 5,800.00 | 4,500.00 | 17,914.64 | 0.00151 | 9,960.00 | 2,486,016.00 |
| 10,000 | Peak | 29,338.08 | 5,800.00 | 15,000.00 | 50,138.08 | 0.00149 | 24,900.00 | 9,860,400.00 |

USD/month. Verified outcome denominator = (inspections + plans) × customers × scenario yield. Selective specialist = incidents × 1.25 attempts × 480 active seconds × $0.0083 × customers. The final column represents every assisted plan at that AWS duration and the scenario multiplier. At replacement subtract displaced per-plan costs and add attributed specialist telemetry and review. This is a spend sensitivity, and differences in verified quality and latency remain unmeasured. To compare each candidate across all 16 cases, multiply its unit rate by the relevant same-column quantity, customer count and attempt factor, then subtract only the displaced path. Identity/Gateway use actual tokens or authorizations, memory uses actual bytes and retrievals, and specialist setup, security and transformation spend remain separately attributable engineering expenses.

The following monthly USD figures price comparable managed components before replacing their owned counterparts. They are separate from base COGS and are not additive unless the proposed path uses all the components. Runtime assumes one CPU-s and GB-s per inspection, three CPU-s and ten GB-s per plan. Tools keep the same browser and code durations from the candidate table. Gateway/Policy assumes two calls and one authorization per operation, plus a search for 10% of plans. Memory assumes 2 KB ingested, 4 KB retrieved, 2 KB active storage, 0.2 long-term records and one long-term retrieval per plan. Managed evaluation assumes 2,000 input and 500 output tokens on each plan. Multiply each count by the same scenario attempt factor. Harness consumes the applicable Runtime, tools and memory columns plus inference. Add outbound Identity at $0.00001 per independently charged credential request. The Step Functions column uses six Standard transitions per inspection or plan. AWS Security Agent/Continuum and Transform are optional internal job pricing above; neither has assumed customer usage.

| Customers | Usage | Runtime v1 | Runtime v2 | Browser + interpreter | Gateway + Policy | Memory | Eval | Step Functions |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Light | 0.001 | 0.002 | 0.000 | 0.001 | 0.001 | 0.011 | 0.006 |
| 1 | Typical | 0.009 | 0.013 | 0.006 | 0.010 | 0.009 | 0.145 | 0.042 |
| 1 | Heavy | 0.049 | 0.072 | 0.046 | 0.057 | 0.041 | 0.674 | 0.243 |
| 1 | Peak | 0.188 | 0.276 | 0.212 | 0.217 | 0.162 | 2.673 | 0.928 |
| 100 | Light | 0.124 | 0.181 | 0.000 | 0.148 | 0.067 | 1.112 | 0.633 |
| 100 | Typical | 0.874 | 1.285 | 0.633 | 0.991 | 0.878 | 14.515 | 4.234 |
| 100 | Heavy | 4.917 | 7.218 | 4.624 | 5.694 | 4.075 | 67.392 | 24.336 |
| 100 | Peak | 18.822 | 27.636 | 21.194 | 21.718 | 16.162 | 267.300 | 92.812 |
| 1,000 | Light | 1.236 | 1.812 | 0.000 | 1.481 | 0.673 | 11.124 | 6.334 |
| 1,000 | Typical | 8.743 | 12.849 | 6.332 | 9.912 | 8.776 | 145.152 | 42.336 |
| 1,000 | Heavy | 49.170 | 72.181 | 46.245 | 56.940 | 40.747 | 673.920 | 243.360 |
| 1,000 | Peak | 188.224 | 276.361 | 211.944 | 217.181 | 161.618 | 2,673.000 | 928.125 |
| 10,000 | Light | 12.363 | 18.116 | 0.000 | 14.806 | 6.726 | 111.240 | 63.345 |
| 10,000 | Typical | 87.435 | 128.494 | 63.324 | 99.120 | 87.763 | 1,451.520 | 423.360 |
| 10,000 | Heavy | 491.703 | 721.812 | 462.448 | 569.400 | 407.472 | 6,739.200 | 2,433.600 |
| 10,000 | Peak | 1,882.237 | 2,763.613 | 2,119.440 | 2,171.813 | 1,616.175 | 26,730.000 | 9,281.250 |

### Qualification and economic controls

1. Reuse the same oracle across eligible alternatives: healthy A and B, exact retained A, provider unreachable, stale/wrong scope and source, revoked access, and an ambiguous accepted invocation. Add a bounded non-mutating incident report for intelligence comparators. Verify outcome, latency p50/p95, false health/refusals, retries, reliability, metered price and operator time. The private [A→B→A receipt](https://linear.app/paigeagentai/issue/ANT-176#comment-545cd468-1d32-4d92-8ec2-031211cee11a) has 3 real healthy results, 2,529 billed ms at 128 MiB, and about $0.000024 for the measured lifecycle operations. Peer compute and managed specialist benchmarks remain unrun; cost modeled here is not relative-quality proof.
2. Existing Cloud scoped inspection is deterministic, uses the original Spine decision before provider work, and reserves a single attempt for the active organization. The private limit is one per 30 seconds and 24 per UTC day. A single invoke, client deadline, worker timeout and retained capacity charge for failures make stopping enforceable. At the modeled rate it is $0.00893 per tenant for 31 days at that cap, plus shared services. Actual metering is required for economic acceptance. No automatic recovery or model call.
3. Extend the operating loop through current Trust claims, Spine decisions, Work/Harness leases and bounded effects, Orchestration dispatch and reconciliation, Rail receipts and Intelligence evaluation. A later budget reserves gross usage before dispatch, with enforced token/workload/concurrency limits, cancellation, expiry and reconciled provider actuals. Treat unknown outcomes as unresolved and avoid blind replay. Forecast credits and net separately. Billing alerts support this path; the admission and worker limits enforce it.
4. Check specific feature/version/region and quotas, data classification, export, subprocessors, retention/deletion, release and licensing terms. AgentCore publishes Ohio support for core tools and Harness; check each platform version before any use. Some AWS AI services process prompts outside their control region, and product-specific data terms apply. Embedded commercial rights and support terms require separate qualification. Review pinned open-source licenses, notices, dependencies and redistribution. Preserve the deterministic recovery path. [AWS terms](https://aws.amazon.com/service-terms/) · [DevOps Agent data protection](https://docs.aws.amazon.com/devopsagent/latest/userguide/aws-devops-agent-security.html).

## Historical hosting comparison

The original VPS and Vercel-era comparison is retained as historical evidence. Current serving and migration direction is in [ANT-169](https://linear.app/paigeagentai/issue/ANT-169) and [ANT-176](https://linear.app/paigeagentai/issue/ANT-176).

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
