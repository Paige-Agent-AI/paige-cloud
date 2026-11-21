# PAIGE Cloud nonproduction preview

The private `Paige-Agent-AI/paige-cloud-preview` repository builds the public PAIGE frontend pinned in `upstream.commit`. The governed preview serves static content and blocks authentication and write requests on the existing Hostinger KVM 2 managed by Coolify Cloud.

- [Existing F1 preview](https://fxfz4l18wzsufmveobxljvce.179.66.154.248.sslip.io)
- [Release, rollback and recovery](docs/05-rollback-runbook.md)
- [Monitoring and observed infrastructure costs](docs/10-monitoring-cost-visibility.md)
- [SaaS readiness and build sequence](docs/11-saas-readiness.md)
- [Historical F2 review receipt](docs/08-f2-review-receipt.md)

Run the candidate build and smoke tests from the independently reviewed commit using Docker and Node.js:

```bash
EXPECTED_CLOUD_COMMIT="$(git rev-parse HEAD)" bash scripts/build-preview.sh paige-cloud-preview:local
```

The GitHub Actions workflow runs the same script before publishing. To run a published image locally, set `PAIGE_PREVIEW_IMAGE` to the recorded `ghcr.io/paige-agent-ai/paige-cloud-preview@sha256:…` digest and run `docker compose up`. Compose binds port 8080 to localhost.

The previous v3 and v4 URLs and deployment IDs are in the operating record. The old README URL beginning `h0llaikzrfpua1ugygaadpjq` returned HTTP 503 on November 20, 2026.
