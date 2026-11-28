# Private Solo streaming

The Cloud streaming API is a separate service from the owner pilot and the public PAIGE and Release B deployments. The approved Solo and OAuth source owners wire the application caller and verify the actual shell through [ANT-180](https://linear.app/paigeagentai/issue/ANT-180/paige-cloud-private-obs-streaming-in-the-solo-shell).

## Solo adapter contract

Resolve the actor, workspace, and role from the established PAIGE session on the server. The trusted OAuth issuer binds the verified workspace ID to `paige_workspace_id`. Each access token is an RS256 JWT with `typ` set to `at+jwt`, exact issuer, a single Cloud API audience, registered PAIGE client ID, and a lifetime of at most five minutes. The issuer must load the workspace grant from trusted data. A browser-supplied workspace ID alone cannot authorize an event. Keep the token in the Solo backend and relay media through the authorized Solo session. Preserve relative HLS URLs, media types and Range/Content-Range headers across the relay. The Cloud API never uses a workspace ID supplied by the consumer separately from the access token.

| Method and path | Scope | Result |
| --- | --- | --- |
| GET `/v1/stream-events` | `streams:read` | Workspace event list |
| POST `/v1/stream-events` | `streams:host` | Create event with JSON `title` and stable `Idempotency-Key` |
| GET `/v1/stream-events/{id}` | `streams:read` | Event state, live or replay relative path and recording duration when available |
| POST `/v1/stream-events/{id}/encoder` | `streams:host` | One response with the OBS custom RTMPS server and stream key |
| POST `/v1/stream-events/{id}/finish` | `streams:host` | Finalize after OBS has disconnected |
| GET `/v1/stream-events/{id}/hls/{asset}` and `/replay.mp4` | `streams:read` | Live bytes or recording bytes |

A viewer cannot create, finish or issue an encoder key. Requests for another workspace's event return 404. Issuing a replacement key revokes the previous unused key. One event key admits one encoder connection within 15 minutes and the connection lasts at most 30 minutes. Once admitted, the same event cannot be reused for another connection. If a connection drops, use the captured recording and create a new event for a new broadcast. Live video is private to authorized viewers. `stop_obs_first` and `broadcast_settling` are 409 responses, so the Solo shell can let a host retry Finish. An event ends without a replay if no recording became available before the admitted session expired. The pilot supports two allowlisted workspaces, one active publish session per workspace and up to 100 event records per workspace.

Set `PAIGE_SOLO_WORKSPACES` to the approved fixture or preview workspace IDs. Configure the trusted `PAIGE_SOLO_OAUTH_ISSUER`, `PAIGE_SOLO_OAUTH_JWKS_URL`, `PAIGE_SOLO_OAUTH_RESOURCE` and `PAIGE_SOLO_OAUTH_CLIENT_ID` as runtime settings. The resource should be the exact HTTPS URL ending in `/v1/stream-events`. Use a dedicated `PAIGE_SOLO_ENCODER_ORIGIN` with a trusted certificate, mount the key and certificate as readable only by the service at `/tls/tls.key` and `/tls/tls.crt`, and expose only the HTTPS API proxy and the RTMPS TCP port. Keep `/recordings` on the service volume. Raw recordings expire after seven days. API role grants and the issuer are administered outside this image. Configure the HTTP server to redact authorization and encoder credentials in logs.

## Connections and destinations

This service is an OAuth protected resource. It publishes metadata at `/.well-known/oauth-protected-resource/v1/stream-events` and advertises the issuer on a 401 challenge. For a remote MCP connection, use a different protected resource audience and OAuth authorization code with PKCE and user consent. A future MCP adapter should call the same tenant-checked event logic using the user’s grant. Keep encoder credentials and any public-broadcast controls out of the first MCP tools. Cloud and Solo use the same issuer contract with separately scoped clients.

YouTube Live is a possible first external destination. Implement forwarding later as a tenant-owned destination and a per-event publishing decision. Keep the private recording and viewer authorization independent of provider failures. Platform Operator destinations must belong to an authorized operator workspace and use the same event boundary. This API defines private events and accepts no external destination fields.

## Verification

Run `npm --prefix solo-streaming ci --ignore-scripts` and `node --test solo-streaming/server.test.mjs` against Node 24. The PR workflow exercises two simultaneous real RTMPS publishers with synthetic video, their HLS segments, recorded MP4 byte ranges, and reciprocal denial of cross-workspace access. Those fixtures establish service behavior. Solo shell acceptance also needs the approved application adapter and two signed-in Solo workspace contexts.
