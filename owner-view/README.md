# PAIGE Cloud owner deployment view

[ANT-177](https://linear.app/paigeagentai/issue/ANT-177) tracks the private dashboard. The public F2 preview is a separate Coolify app. The dashboard reads its HTTPS `/healthz` and `/release.json` endpoints and the provider's application and deployment history metadata. It does not promote or rebuild releases. The accepted [F2 release evidence](https://linear.app/paigeagentai/issue/ANT-176) supplies the deployment-to-digest mapping. A new or ambiguous deployment, a changed digest, and a conflicting source manifest all leave the release unconfirmed.

## Publish and host

1. Test with `node --test owner-view/status.test.mjs owner-view/server.test.mjs` from the Cloud checkout. Have a non-author review the exact source. Push a dedicated `ant-177-owner-view-*` release tag to the private Cloud repo to run the image build. Record the Actions run and immutable GHCR manifest digest from its summary.
2. Run one copy of the digest-pinned image on the existing VPS in its own Coolify app. Route a distinct HTTPS origin through the Coolify proxy to the container's port 8080. Leave host port mappings and auto-deploy off. Use `GET /healthz` for process readiness. This endpoint returns only `ok` and does not probe the public preview.
3. Supply `OWNER_VIEW_ORIGIN` as the exact HTTPS origin, with no path or trailing slash. Use `OWNER_VIEW_COOLIFY_TOKEN` for a dedicated Coolify token with only the `read` permission and only the `paige-cloud-f2` app selected. Use runtime-only secret variables. Keep the general release credential out of the dashboard. Verify the scoped token reads the two intended API endpoints and denies access to another app.
4. Generate an owner key from 32 random bytes encoded as unpadded base64url. Keep the key in the owner's password manager or Windows user-protected storage. Put only its lowercase hexadecimal SHA-256 of the UTF-8 key string into `OWNER_VIEW_PASSWORD_SHA256`. Changing the hash and restarting the dashboard rotates the key and invalidates the existing in-memory sessions. The sign-in expires after 30 minutes.
5. Verify the unauthenticated API denies access, the owner can view B and A, sign-out invalidates the session, the link works over HTTPS, and port 8080 has no public mapping. Recheck F2 independently after deployment.

Start or restart the **owner view only** for credential rotation or recovery. To undo an owner view deployment, select its last reviewed image digest in the owner view's Coolify app. This does not change the selected digest in the public F2 app.
