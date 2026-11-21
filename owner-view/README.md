# PAIGE Cloud owner deployment view

[ANT-177](https://linear.app/paigeagentai/issue/ANT-177) tracks the private dashboard. The public F2 preview is a separate Coolify app. The dashboard reads its HTTPS `/healthz` and `/release.json` endpoints and the provider's application and deployment history metadata. It does not promote or rebuild releases. The accepted [F2 release evidence](https://linear.app/paigeagentai/issue/ANT-176) supplies the deployment-to-digest mapping. A new or ambiguous deployment, a changed digest, and a conflicting source manifest all leave the release unconfirmed.

The owner overview also checks PAIGE Agent AI's three production domains through public HTTPS GET requests. It reports a shared source commit when all three release manifests agree. Production digest verification remains tied to the release and provider evidence. The Coolify read token stays scoped to the F2 application. See the [SaaS readiness assessment](../docs/11-saas-readiness.md).

## Project access

The owner uses the original key once at `/setup` on the primary hostname. Setup creates an email-and-password account for the existing `cloud-owner` identity and closes the setup route. The Cloud membership database stores that identity's read grant for the `paige` organization's `paige-agent-ai` project. The project's registered environments are `production` and `f2-preview`. Each environment inherits the project's read grant and has its own status reader. Production reads public manifests and health endpoints. The F2 reader alone uses the Coolify token.

The console uses `GET /api/organizations/paige/projects/paige-agent-ai/status`. Add `/environments/{environmentId}` before `/status` to read a single environment. The legacy `GET /api/status` checks the same project grant. The server checks the session and grant before it consults the cache or calls a reader. Unknown and unauthorized scopes share the same HTTP 404 response.

Project readers are bound in source. Memberships use the exact principal, organization and project tuple in a private SQLite file. The server rechecks the grant before responding, including after an in-flight read. The console clears displayed data when its next status request returns a project denial.

After owner setup, approved evaluators can create an account at `/signup`. The operator-only command `node accounts.mjs invite <email>` still creates a 48-hour account invitation without a project grant. Deliver these codes privately. Treat the accounts database as credential material. Only salted password hashes are stored.

## Projects and members

Open **Projects** to create a project, edit its display name, or archive and restore it. Organization and project IDs remain stable. PAIGE Agent AI has a fixed display name and stays connected to its reviewed deployment readers. New projects are private records until connected to their own deployment source.

Overview and Deployments use `/overview` and `/deployments`. The projects list uses `/projects`. Project details use `/projects/{organizationId}/{projectId}` and owner-only Members uses that project URL followed by `/members`. Invitation acceptance uses `/join`.

In a project, the Cloud owner can prepare an invitation for one email. **Open email draft** opens the selected mail app with the address, setup instructions, and a 48-hour code. The owner sends the draft. An invited evaluator creates an account if needed, signs in, and enters the same code under **Accept an invitation**. Acceptance grants access to that one project. Pending invitations can be cancelled. Revocation takes effect on the member's next project request and cancels any pending invitation to the same member for that project.

The console extends the existing membership file on startup in a SQLite transaction. Existing grants are preserved. Archived projects retain their IDs and grants for restoration, while active member access and pending invitations are closed. Keep both database files on the **same** private local volume in rollback-journal mode.

For recovery, keep the console offline while reconciling membership changes and archived projects since the snapshot. Invalidate all project invitations restored from the snapshot with `DELETE FROM project_invitations` using a trusted SQLite client, then reissue the current invitations after verification. The post-enrollment PR #7 image can read the original grants on the same file and only serves the canonical deployment reader. Invalidate outstanding project invitations before resuming catalogue operation after any rollback that used older membership tools.

### Membership storage and administration

- Mount a private local volume on the owner console, for example at `/var/lib/paige-cloud`. Use a local filesystem that supports SQLite locking and hard links. Give the container's `node` user read and write access to the private directory and both databases. Set `OWNER_VIEW_MEMBERSHIP_DB` to the absolute file path under the mount, for example `/var/lib/paige-cloud/memberships.sqlite`. Verify actual mount and write access before deploying the catalog.
- Run `node memberships.mjs init` once for an empty installation to seed the schema and first owner grant. A repeated init checks the existing database and preserves revocations. Console startup requires the existing file and schema, then creates the additive catalog tables without reissuing grants.
- Run `node memberships.mjs grant cloud-owner paige paige-agent-ai` or `node memberships.mjs revoke cloud-owner paige paige-agent-ai` on the same mounted file. These are idempotent local operator commands. After changing a grant, verify the signed-in project status route. Supported project readers and the owner identity still come from the application.
- Before starting the updated image, run `node accounts.mjs init` using its `node` user and the same private mounted directory. It initializes `accounts.sqlite` alongside the membership file. Start the console only after both files are present. Keep a private SQLite-consistent backup of both files, including an accounts backup after owner setup. For recovery, stop only the Cloud owner app and restore the paired files from a known-good backup taken after setup. A lost password requires separate operator-assisted recovery. Keep the account records intact during recovery.
- Use a SQLite-aware backup or stop the writer and console for a consistent offline copy. Reconcile revocations before restarting against a restored copy. Keep the console offline if rolling back to an older image with a hardcoded grant. A database-aware rollback image must support the stored schema and enforce current grants.

## Publish and host

1. Test with `node --test owner-view/status.test.mjs owner-view/server.test.mjs` from the Cloud checkout. Have a non-author review the exact source. Push a dedicated `ant-177-owner-view-*` release tag to the private Cloud repo to run the image build. Record the Actions run and immutable GHCR manifest digest from its summary.
2. Run one copy of the digest-pinned image on the existing VPS in its own Coolify app. Route a distinct HTTPS origin through the Coolify proxy to the container's port 8080. Leave host port mappings and auto-deploy off. Use `GET /healthz` for process readiness. This endpoint returns only `ok` and does not probe the public preview.
3. Supply `OWNER_VIEW_ORIGIN` as the exact HTTPS origin, with no path or trailing slash. Use `OWNER_VIEW_COOLIFY_TOKEN` for a dedicated Coolify token with only the `read` permission and only the `paige-cloud-f2` app selected. Use runtime-only secret variables. Keep the general release credential out of the dashboard. Verify the scoped token reads the two intended API endpoints and denies access to another app.
   For additional dashboard hostnames, use `OWNER_VIEW_ALIAS_ORIGIN` for one existing alias and `OWNER_VIEW_ADDITIONAL_ORIGINS` for a comma-separated list of exact HTTPS origins. Add each hostname to the same app in Coolify after public DNS is ready. Owner sessions stay scoped to the hostname where the owner signed in.
4. Keep the existing `OWNER_VIEW_PASSWORD_SHA256` for first setup. The owner enters the existing key and chooses a new password privately at `/setup`. After the owner confirms password access and the accounts backup, remove the bootstrap hash from this app. Sign-in expires after 30 minutes. Restarting the console invalidates its in-memory sessions.
5. Verify the unauthenticated API denies access, the password-authenticated owner can view B and A, a new account has no project access, sign-out invalidates the session, the link works over HTTPS, and port 8080 has no public mapping. Recheck F2 independently after deployment.

Start or restart the **owner view only** for credential rotation or recovery. Before setup, the previous reviewed image can serve the key-based owner console during a rollback. After setup, roll back only to a reviewed account-capable image. Leave the public F2 app on its own selected digest.
