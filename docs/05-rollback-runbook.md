# PAIGE Cloud preview release and rollback

## Build a candidate

1. Have a non-author review the full Cloud Git SHA, including the frontend pin, Docker inputs and isolation checks. Keep write and dispatch access limited to release operators.
2. In the private Cloud repository, open **Actions → Build PAIGE Cloud preview → Run workflow**. Select `main` and provide the reviewed SHA and review reference. The workflow verifies the SHA, runs the build from pinned source and bases with `npm ci`, and tests the running image before publishing to private GHCR. The operator checks that the receipt actually approves that SHA. The workflow records the reference as supplied.
3. Save the JSON from the successful job summary to a release record. It identifies both source SHAs, the workflow run, the reviewed candidate tag and its resolved manifest digest. Retain at least the two verified digests in GHCR for recovery after Docker cleanup.

## Promote a verified digest

Use the dedicated `paige-cloud-f2` Docker Image application in **PAIGE Cloud Preview** on the existing server. Keep its generated HTTPS hostname and UUID. Use port 8080, enable the `GET /healthz` health check expecting 200, disable auto-deploy and leave app environment variables and persistent volumes empty. Coolify needs a package-reader login on the existing server.

Set `COOLIFY_PREVIEW_APP_UUID` to the dedicated app UUID. Load the scoped API credential from the approved secret store. Run:

```bash
node scripts/deploy-preview.mjs candidate.json previous.json
```

On the first deploy only, use `bootstrap` in place of `previous.json` after creating the app with the first approved digest and instant deploy disabled. Coolify stores the selected digest as `sha256-<hex>` in **Docker Image Tag or Hash**. Reserve the release window with other operators and serialize changes through readback.

Capture the UTC timestamps, environment, app UUID and URL, source SHAs, GHCR digest, deployment ID, final result, and previous verified digest. Keep the Coolify log lines showing image reference and startup, the HTTP results and screenshot. Use a read-only Docker inspection when the provider log lacks image identity. The public `/release.json` reports embedded source identity. The registry and provider records identify the digest.

## Roll back, then verify recovery

- After a successful deployment, promote the earlier release JSON using the current release JSON as the second argument. This pulls the previously published digest and serves it on the same app. Use the same path to return to the approved recovery release.
- After a failed deployment, read Coolify deployment logs and compare the configured digest with the last known-good HTTP identity. Wait for active replacement to finish. Save the last verified digest under **General → Docker Registry → Docker Image Tag or Hash**, then select **Redeploy**. Record the new deployment ID and run:

  ```bash
  node scripts/verify-preview.mjs "$PREVIEW_URL" "$PRIOR_CLOUD_SHA" "$PRIOR_FRONTEND_SHA"
  ```

- A drill records **A → B → A → B** on one HTTPS endpoint. Run a controlled failure only on the dedicated app with a verified recovery digest available.

## Legacy app history

The Dockerfile-in-Coolify deployments were separate apps using mutable local tags and a floating upstream clone. Their two healthy URLs establish no same-app rollback or exact image mapping. The historical review receipt is preserved.
