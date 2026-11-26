# PAIGE Cloud nonproduction preview

The private `Paige-Agent-AI/paige-cloud` repository builds the public PAIGE frontend pinned in `upstream.commit`. The governed preview serves static content and blocks authentication and write requests on the existing Hostinger KVM 2 managed by Coolify Cloud.

- [Existing F1 preview](https://fxfz4l18wzsufmveobxljvce.179.66.154.248.sslip.io)
- [Release, rollback and recovery](docs/05-rollback-runbook.md)
- [Monitoring and observed infrastructure costs](docs/10-monitoring-cost-visibility.md)
- [SaaS readiness and build sequence](docs/11-saas-readiness.md)
- [Historical F2 review receipt](docs/08-f2-review-receipt.md)

Run the candidate build and smoke tests from the independently reviewed commit using Docker and Node.js:

```bash
EXPECTED_CLOUD_COMMIT="$(git rev-parse HEAD)" bash scripts/build-preview.sh paige-cloud-preview:local
```

The GitHub Actions workflow runs the same script before publishing. To run a published image locally, set `PAIGE_PREVIEW_IMAGE` to the recorded `ghcr.io/Paige-Agent-AI/paige-cloud@sha256:…` digest and run `docker compose up`. Compose binds port 8080 to localhost.

## Pull request previews

The signed GitHub webhook queues a preview for each new head of a same-repository PAIGE Agent AI pull request targeting `main`. GitHub Actions checks that exact open PR, builds a static image with a preview-only configuration, and publishes an image receipt. A separate job deploys the verified digest to the dedicated Coolify project. The console links the PR's stable HTTPS URL after the running preview reports the exact PR commit and passes its health check.

The private Cloud repository's `paige-pr-previews` environment admits only its `main` branch. Configure `PAIGE_PREVIEW_PROJECT`, `PAIGE_PREVIEW_ENVIRONMENT`, `PAIGE_PREVIEW_DESTINATION`, and `PAIGE_PREVIEW_SERVER` there. Store `PAIGE_PREVIEW_COOLIFY_TOKEN` there with Read, Write, and Deploy permissions scoped to the dedicated Coolify preview project. Set the repository variable `PAIGE_PREVIEW_AUTO_DEPLOY_ENABLED` to `true` after verifying that scope. The console uses `OWNER_VIEW_PREVIEW_DISPATCH_TOKEN` with Actions write access only to the private Cloud repository. Its existing `OWNER_VIEW_PREVIEW_ACTIONS_TOKEN` reads preview runs independently.

Use a separate preview server for the unattended Coolify Write credential. Bootstrap a resource in the dedicated preview scope on that server before enabling automatic application provisioning. Coolify lets a project-scoped token place resources only on servers already hosting a resource in its scope. Project-scoped Write permissions can reach the underlying Docker host. Keep the deployment switch off for shared hosting. Signed events still build the preview image, and an operator can deploy a verified pilot receipt.

For a dedicated Coolify server, set the repository variable `PAIGE_PREVIEW_PUBLISH_PROVIDER` to `coolify`. Set `PAIGE_PREVIEW_PUBLIC_IP` in both the private GitHub preview environment and the PAIGE Cloud console runtime. Each preview uses `https://pr-<number>.preview.<public-ip>.sslip.io`. Check that the preview server's public ports 80 and 443 reach its Coolify proxy and that the server can pull the preview image by digest. Keep the two IP settings in sync when moving hosts.

Cloudflare Pages Free is available as a separate static preview host. Set the repository variable `PAIGE_PREVIEW_PUBLISH_PROVIDER` to `cloudflare-pages`. Add `PAIGE_PREVIEW_PAGES_PROJECT` and `PAIGE_PREVIEW_CLOUDFLARE_ACCOUNT_ID` to the main-only GitHub preview environment, along with `PAIGE_PREVIEW_CLOUDFLARE_TOKEN` scoped to Pages. Set the same project name as `PAIGE_PREVIEW_PAGES_PROJECT` in the console runtime. The Cloudflare project uses Direct Upload, with a per-PR branch such as `pr-3401`. The publisher sends only verified static assets without Pages Functions or production credentials. Page routes use the provider's static SPA fallback for unmatched reads. A publish succeeds after the branch alias serves both exact commits and passes HTTPS and write-denial checks.

Use one signed delivery from GitHub and follow it through Actions, Coolify, and the console to verify a rollout. Check the full commit in `release.json` and the health response in `/healthz`. Before retrying a timed-out rollout, look up the existing Coolify deployment. Use **Re-run all jobs** so the build and deploy jobs share the same workflow attempt. Builds reject run receipts for an old PR head or a different workflow attempt.

## Production release history

The console imports verified production receipts from canonical PAIGE Agent AI GitHub Actions and reads deployment history from the `paige-full-app` Coolify application. Set the console's `OWNER_VIEW_PRODUCTION_ACTIONS_TOKEN` to Actions read access on only the canonical GitHub repository. Set `OWNER_VIEW_PRODUCTION_COOLIFY_TOKEN` to read access on only that Coolify application. Neither history reader needs deployment or secret-read permissions. Verified receipts persist in the console's existing data volume. Provider rollouts without corroborating evidence are labeled accordingly. Older expired receipts may be missing from GitHub.

For subscriber onboarding, allocate a dedicated tenant project and preview deployment scope. Bind the repository, registry, approved deployment destinations, and HTTPS preview domain to that project. Production history credentials and preview deploy credentials belong to the subscriber's project, with separate production and preview permissions. Verify the same PR-to-HTTPS flow and project membership checks before enabling automation for the subscriber. The current deployment is configured for PAIGE Agent AI.

The previous v3 and v4 URLs and deployment IDs are in the operating record. The old README URL beginning `h0llaikzrfpua1ugygaadpjq` returned HTTP 503 on November 20, 2026.
