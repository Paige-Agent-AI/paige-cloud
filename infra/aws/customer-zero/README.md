# Customer Zero account service

The account package uses Cognito for password authentication, email verification, recovery, and token revocation. Its SQL store binds verified issuer and subject to a stable account number. It creates the initial organization and membership together. The runtime database login can call scoped functions without access to the underlying tables. Existing console and application deployments use their current stores.

`artifacts.yaml` supplies a private versioned artifact bucket and the generated secret shared by CloudFront and the account function. `accounts.yaml` declares an isolated Cognito pool, an Aurora PostgreSQL writer, and the account API. Evaluator routes default to disabled. `site-edge.yaml` restricts the evaluator site to one operator-supplied IPv4 address and disables IPv6 at the distribution. The account behavior forwards the session cookie and request origin without caching. The site hostname from the edge stack becomes the exact allowed origin for browser writes. The account function requires the edge's secret before accepting any route, including GET requests.

Build a versioned function artifact from `owner-view/aws-accounts` using its lockfile and Node.js 24. Package `handler.mjs`, `runtime.mjs`, `mission-control.html`, the dependency manifest and production dependencies. Keep the operator-only `bootstrap.mjs` and the PostgreSQL migration out of the Lambda artifact. The Mission Control entry validates the Cognito session and account before serving the private workspace shell. The isolated workspace provides onboarding and account settings. Infrastructure controls require their own data and authorization integration.

Create the artifact stack, then the accounts stack with a temporary HTTPS origin and routes disabled. Create the site stack using the resulting API hostname and upload the approved `site/` assets without publishing the bucket. Bootstrap the database twice. Update the accounts stack with the distribution hostname and enable evaluator routes after confirming the exact candidate. Never use the legacy distribution, domain, or production API for this procedure.

The operator migration uses a separate database administrator credential. After the database writer is ready, run `node owner-view/aws-accounts/bootstrap.mjs` with the cluster ARN, administrator secret ARN and provisioned runtime secret ARN in the operator's environment. It checks the migration checksum and verifies the application login with the runtime secret. Do the same readback after a restore. A replaced runtime secret requires synchronized rotation or restoration of the matching secret version.

Validate the exact artifact, database login, trusted HTTPS path and protected account routes before enabling evaluator access. Confirm that CloudFront forwards `Set-Cookie` and the session cookie, preserves scope across requests and does not cache an authenticated response. Verify registration, verification, recovery, sign-out and reciprocal organization denial with approved evaluators. Confirm backup restoration and attributable costs before production cutover.

## Private registry contract

Migration `002-registry.sql` is additive. The operator bootstrap applies it through the existing migration lock and checksum ledger after validating `001`. Run bootstrap twice to verify replay. Older Lambda versions can continue to serve account flows with the additive tables present. Roll back the application artifact to its earlier immutable version if needed. Keep the registry data for forward recovery.

Use an existing verified evaluator session through the private origin. Writes require that origin and JSON. The server derives the actor from the session, then PostgreSQL checks current membership and project grants. Service credentials and public enrollment require separate qualification.

| Method and path | Scope, request and result |
| --- | --- |
| `GET /api/cloud/v1/organizations/{organization}/projects` | An active organization member reads only their explicitly granted projects. Returns IDs, names and project roles. A new organization can return an empty list. |
| `POST /api/cloud/v1/organizations/{organization}/projects` | An organization owner submits `id` and `name`. Creates one project and its creator’s project-owner grant together. Same request returns the existing record. |
| `GET /api/cloud/v1/organizations/{organization}/projects/{project}/applications` | An active project grantee reads the scoped application and environment registrations. |
| `POST /api/cloud/v1/organizations/{organization}/projects/{project}/applications` | A project owner submits `id`, `name`, `kind` (`application` or `service`), `environment` and optional `sourceRepository` (`owner/repository`). Reuse the same application identity and metadata to attach another environment. Returns the application and its environment IDs. |

IDs accept 1–48 lowercase ASCII letters, digits or hyphens, starting with an alphanumeric character. Names accept 1–120 characters. Registry limits are 50 projects per organization, with 100 applications and 50 environments per project. Success is HTTP 200. Bad fields return 400, a missing session returns 401, denied browser origin returns 403, an inaccessible target returns 404, and conflicting metadata or capacity returns 409. Responses are not cached.

Repository coordinates are desired source metadata. Registration does not fetch source, deploy anything, allocate compute, or read provider credentials. Resolve actual source and publish immutable artifacts as separate, independently authorized steps. The operator workbook should consume this contract after the authenticated navigation is approved.
