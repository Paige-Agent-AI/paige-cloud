# PAIGE Cloud owner deployment view

[ANT-177](https://linear.app/paigeagentai/issue/ANT-177) tracks the private dashboard. The public F2 preview is a separate Coolify app. The dashboard reads its HTTPS `/healthz` and `/release.json` endpoints and the provider's application and deployment history metadata. It does not promote or rebuild releases. The accepted [F2 release evidence](https://linear.app/paigeagentai/issue/ANT-176) supplies the deployment-to-digest mapping. A new or ambiguous deployment, a changed digest, and a conflicting source manifest all leave the release unconfirmed.

The owner overview also checks PAIGE Agent AI's three production domains through public HTTPS GET requests. It reports a shared source commit when all three release manifests agree. Production digest verification remains tied to the release and provider evidence. The Coolify read token stays scoped to the F2 application. See the [SaaS readiness assessment](../docs/11-saas-readiness.md).

## Project access

The owner key creates a session for the `cloud-owner` identity. The Cloud membership database stores that identity's read grant for the `paige` organization's `paige-agent-ai` project. The project's registered environments are `production` and `f2-preview`. Each environment inherits the project's read grant and has its own status reader. Production reads public manifests and health endpoints. The F2 reader alone uses the Coolify token.

The console uses `GET /api/organizations/paige/projects/paige-agent-ai/status`. Add `/environments/{environmentId}` before `/status` to read a single environment. The legacy `GET /api/status` checks the same project grant. The server checks the session and grant before it consults the cache or calls a reader. Unknown and unauthorized scopes share the same HTTP 404 response.

Project readers are bound in source. Memberships use the exact principal, organization and project tuple in a private SQLite file. The server rechecks the grant before responding, including after an in-flight read. The console clears displayed data when its next status request returns a project denial. One owner-key identity is supported in the deployed configuration.

### Membership storage and administration

- Mount a private local volume on the owner console, for example at `/var/lib/paige-cloud`. Use a local filesystem that supports SQLite locking and hard links. Give the container's `node` user read access and run the operator commands as an authorized local user with write access. Set `OWNER_VIEW_MEMBERSHIP_DB` to the absolute file path under the mount, for example `/var/lib/paige-cloud/memberships.sqlite`. Verify the mount and its permissions on the host before initialization.
- Run `node memberships.mjs init` once with the reviewed image and the correct mounted path. It creates the schema and first owner's grant in one transaction in a private staging directory, then publishes the committed file without replacing any existing database. A repeated init checks the existing database and preserves revocations. The console opens the existing database read-only and startup fails if the file or expected schema is missing.
- Run `node memberships.mjs grant cloud-owner paige paige-agent-ai` or `node memberships.mjs revoke cloud-owner paige paige-agent-ai` on the same mounted file. These are idempotent local operator commands. After changing a grant, verify the signed-in project status route. Supported project readers and the owner identity still come from the application.
- Use a SQLite-aware backup or stop the writer and console for a consistent offline copy. Reconcile revocations before restarting against a restored copy. Keep the console offline if rolling back to an older image with a hardcoded grant. A database-aware rollback image must support the stored schema and enforce current grants.

## Publish and host

1. Test with `node --test owner-view/status.test.mjs owner-view/server.test.mjs` from the Cloud checkout. Have a non-author review the exact source. Push a dedicated `ant-177-owner-view-*` release tag to the private Cloud repo to run the image build. Record the Actions run and immutable GHCR manifest digest from its summary.
2. Run one copy of the digest-pinned image on the existing VPS in its own Coolify app. Route a distinct HTTPS origin through the Coolify proxy to the container's port 8080. Leave host port mappings and auto-deploy off. Use `GET /healthz` for process readiness. This endpoint returns only `ok` and does not probe the public preview.
3. Supply `OWNER_VIEW_ORIGIN` as the exact HTTPS origin, with no path or trailing slash. Use `OWNER_VIEW_COOLIFY_TOKEN` for a dedicated Coolify token with only the `read` permission and only the `paige-cloud-f2` app selected. Use runtime-only secret variables. Keep the general release credential out of the dashboard. Verify the scoped token reads the two intended API endpoints and denies access to another app.
   For additional dashboard hostnames, use `OWNER_VIEW_ALIAS_ORIGIN` for one existing alias and `OWNER_VIEW_ADDITIONAL_ORIGINS` for a comma-separated list of exact HTTPS origins. Add each hostname to the same app in Coolify after public DNS is ready. Owner sessions stay scoped to the hostname where the owner signed in.
4. Generate an owner key from 32 random bytes encoded as unpadded base64url. Keep the key in the owner's password manager or Windows user-protected storage. Put only its lowercase hexadecimal SHA-256 of the UTF-8 key string into `OWNER_VIEW_PASSWORD_SHA256`. Changing the hash and restarting the dashboard rotates the key and invalidates the existing in-memory sessions. The sign-in expires after 30 minutes.
5. Verify the unauthenticated API denies access, the owner can view B and A, sign-out invalidates the session, the link works over HTTPS, and port 8080 has no public mapping. Recheck F2 independently after deployment.

Start or restart the **owner view only** for credential rotation or recovery. To undo an owner view deployment, select its last reviewed image digest in the owner view's Coolify app. This does not change the selected digest in the public F2 app.
