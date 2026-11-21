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
3. For a manual promotion, select `paige-full-app` in the Coolify `production` environment. Check that the app is healthy and there is no active deployment. Update only **Docker Image Tag or Hash** to the release artifact's `coolifyTag`, then deploy. The existing server's GHCR package-reader login is sufficient.
4. Wait for Coolify to finish. Confirm the deployment log pulled the intended digest, `/healthz` returns `200`, and `/release.json` matches both source SHAs. Check the homepage and the auth entry on the branded domain and record the Coolify deployment ID. EXP00 and EXP01 own functional validation of signup and onboarding.
5. If the release fails, wait until Coolify has finished the attempt, put the prior verified `coolifyTag` back and redeploy on `paige-full-app`. Verify health and the prior `/release.json` again. Keep Release B, its preview app and the Cloud dashboard out of this deployment path.

### Automatic promotion

The canonical repository's merge workflow uses `workflow_dispatch` to send the exact merge SHA and pull request number. The receiver verifies the current canonical `main`, the merge record, and the existing release maintainer's GitHub ID. The maintainers continue to conduct the independent exact-head review before merging. If canonical `main` has advanced, the newer approved merge is responsible for deployment. Build-only dispatches omit the pull request number.

The canonical repository's `PAIGE_CLOUD_DISPATCH_TOKEN` Actions secret is a fine-grained GitHub token for `paige-cloud-preview` with **Actions: Read and write**. The public repository's workflow never handles the Coolify token.

The publishing job builds and checks the image before a separate runner can promote it. Store `PAIGE_COOLIFY_DEPLOY_TOKEN` as an Actions secret in this private repository. The Coolify token needs `read`, `write` and `deploy` for only the `paige-full-app` resource. In **Run workflow**, supply the current frontend SHA and select **Verify the scoped Coolify credential and live domains without deploying**. The job checks that the token sees only `paige-full-app` and access to the dashboard, Release B and team endpoints is denied. Set the repository variable `PAIGE_AUTO_DEPLOY_ENABLED` to `true` only after this check passes. Set it to `false` to pause automatic promotion before recovery work. Let any in-progress promotion finish before manually changing the tag.

The production job verifies the public domains, deployment queue and health before changing the image tag. It records the previous live source and configured tag. A failed or ambiguous deployment requires inspection of the queue, provider pull logs and live `/release.json`. For manual recovery use the digest verified from the original release receipt and Coolify pull evidence. A configured tag can differ from the image that is serving traffic. A rerun must still match approved canonical `main`. Keep valid scoped credentials during rotation and repeat the read-only workflow check after replacement.

The Cloud organization uses GitHub Free. Keep private Cloud write access limited to release operators because repository-level secrets are available to workflows those users can change. Coolify still enforces the application's resource scope for the credential.
