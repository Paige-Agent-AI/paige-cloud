# PAIGE Cloud preview release and rollback

## Build a candidate

1. Have a non-author review the full Cloud Git SHA, including the frontend pin, Docker inputs and isolation checks. Keep write and dispatch access limited to release operators.
2. In the private Cloud repository, open **Actions → Build PAIGE Cloud preview → Run workflow**. Select `main` and provide the reviewed SHA and review reference. The workflow verifies the SHA, runs the build from pinned source and bases with `npm ci`, and tests the running image before publishing to private GHCR. The operator checks that the receipt actually approves that SHA. The workflow records the reference as supplied.
3. Save the JSON from the successful job summary to a release record. It identifies both source SHAs, the workflow run, the reviewed candidate tag and its resolved manifest digest. Retain at least the two verified digests in GHCR for recovery after Docker cleanup.

## Promote a verified digest

Use the dedicated `paige-cloud-f2` Docker Image application in **PAIGE Cloud Preview → f2-preview** on the existing server. Keep its generated HTTPS hostname and UUID. Use port 8080, enable the `GET /healthz` health check expecting 200, disable auto-deploy and leave app environment variables and persistent volumes empty. Coolify needs a package-reader login on the existing server.

Set `COOLIFY_PREVIEW_APP_UUID` to the dedicated app UUID. Load a scoped Coolify API credential with read, write, deploy and deployment log access from the approved secret store. Run:

```bash
node scripts/deploy-preview.mjs candidate.json previous.json
```

On the first deploy only, use `bootstrap` in place of `previous.json` after creating the app with the first approved digest and instant deploy disabled. Coolify stores the selected digest as `sha256-<hex>` in **Docker Image Tag or Hash**. Confirm that both JSON records match their successful exact-SHA Actions runs and independent reviews. A single operator must own the release window through readback. Coolify applies the configuration update and deployment request as separate operations.

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

## Deploy the full PAIGE app

1. After an approved merge into `Paige-Agent-AI/Paige-Agent-AI` `main`, copy the full merge SHA. In the private Cloud repository, use **Actions → Publish PAIGE app for Coolify → Run workflow** on the default branch and supply that SHA. The workflow rejects a SHA that differs from canonical `main`. If the dispatch integration is enabled, it accepts the same SHA in the `paige-frontend-main` event. The build publishes only after the running image passes the homepage, sign-in and signup route checks. These checks serve the pages without submitting forms.
2. Open the successful Actions run and keep its `paige-app-release-*` artifact. Check the Cloud SHA, frontend SHA, GHCR image digest and `coolifyTag`. Confirm that the frontend SHA is the approved release. Keep the current live digest and `/release.json` as the rollback reference.
3. In Coolify, select `paige-full-app` in the `production` environment. Check that the app is healthy and there is no active deployment. Update only **Docker Image Tag or Hash** to the release artifact's `coolifyTag`, then deploy. The existing server's GHCR package-reader login is sufficient. The Actions workflow never changes Coolify. Release operators carry out the promotion in Coolify.
4. Wait for Coolify to finish. Confirm the deployment log pulled the intended digest, `/healthz` returns `200`, and `/release.json` matches both source SHAs. Check the homepage and the auth entry on the branded domain and record the Coolify deployment ID. EXP00 and EXP01 own functional validation of signup and onboarding.
5. If the release fails, wait until Coolify has finished the attempt, put the prior verified `coolifyTag` back and redeploy on `paige-full-app`. Verify health and the prior `/release.json` again. Keep Release B, its preview app and the Cloud dashboard out of this deployment path.
