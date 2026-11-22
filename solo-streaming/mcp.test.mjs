import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { createStreamAuthorization } from "./auth.mjs";
import { openStreamEvents } from "./events.mjs";
import { createStreamingApi } from "./server.mjs";

test("MCP uses a separate OAuth audience and serves only workspace-scoped status tools", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const issuer = "https://auth.example.test";
  const resource = "https://cloud.example.test/mcp";
  const apiResource = "https://cloud.example.test/v1/stream-events";
  const clientId = "test-mcp";
  const token = (workspace, {
    audience = resource, client = clientId, scope = "streams:status", grant = "authorization_code", expiration = "2m",
  } = {}) => new SignJWT({ client_id: client, scope, paige_workspace_id: workspace, paige_grant_type: grant })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt" }).setIssuer(issuer).setAudience(audience)
    .setSubject("existing-user").setJti("fixture").setIssuedAt().setExpirationTime(expiration).sign(privateKey);
  const auth = createStreamAuthorization({ issuer, resource: apiResource, clientId: "test-api", resolveKey: publicKey });
  const mcpAuth = createStreamAuthorization({ issuer, resource, clientId, resolveKey: publicKey, requiredGrant: "authorization_code" });
  const events = openStreamEvents(":memory:");
  const a = events.create("alpha", "test-alpha-idempotency", "Alpha private").event;
  const b = events.create("beta", "test-beta-idempotency", "Beta private").event;
  const media = { online: async () => false, recording: async () => null };
  const app = createStreamingApi({ auth, mcpAuth, events, media,
    encoderOrigin: "rtmps://stream.example.test", allowWorkspaces: new Set(["alpha", "beta"]) });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => {
    app.closeAllConnections();
    return new Promise((done) => app.close(() => { events.dispose(); done(); }));
  });

  const base = "http://127.0.0.1:" + app.address().port;
  const legacy = "2025-11-25";
  const send = (method, params, bearer, headers = {}) => fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": legacy, ...(bearer ? { Authorization: "Bearer " + bearer } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  async function message(response) {
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    if (response.headers.get("content-type").includes("application/json")) return response.json();
    const sse = await response.text();
    return JSON.parse(sse.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice(6));
  }
  const alpha = await token("alpha");
  const beta = await token("beta");
  const services = await token("alpha", { audience: apiResource, client: "test-api", scope: "streams:read", grant: "client_credentials" });
  const denied = await send("tools/list", {}, undefined);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /resource_metadata="https:\/\/cloud\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.deepEqual(await (await fetch(base + "/.well-known/oauth-protected-resource/mcp")).json(), {
    resource, authorization_servers: [issuer], scopes_supported: ["streams:status"], bearer_methods_supported: ["header"],
  });
  assert.equal((await send("tools/list", {}, services)).status, 401);
  assert.equal((await send("tools/list", {}, await token("alpha", { grant: "client_credentials" }))).status, 401);
  assert.equal((await send("tools/list", {}, await token("alpha", { expiration: "0s" }))).status, 401);
  assert.equal((await send("tools/list", {}, await token("alpha", { scope: "streams:host" }))).status, 403);
  assert.equal((await send("tools/list", {}, await token("other"))).status, 403);
  assert.equal((await send("tools/list", {}, alpha, { origin: "https://unrelated.example.test" })).status, 403);
  assert.equal((await fetch(base + "/v1/stream-events", { headers: { authorization: "Bearer " + alpha } })).status, 401);
  assert.equal((await fetch(base + "/v1/stream-events", { headers: { authorization: "Bearer " + services } })).status, 200);

  const init = await message(await send("initialize", {
    protocolVersion: legacy, capabilities: {}, clientInfo: { name: "mcp-isolation-test", version: "1" },
  }, alpha));
  assert.equal(init.result.protocolVersion, legacy);
  const tools = (await message(await send("tools/list", {}, alpha))).result.tools;
  assert.deepEqual(tools.map((entry) => entry.name).sort(), ["get_stream_event_status", "list_stream_events"]);
  assert.ok(tools.every((entry) => entry.annotations.readOnlyHint === true));
  const modern = await message(await send("tools/list", { _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  } }, alpha, {
    "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list",
  }));
  assert.deepEqual(modern.result.tools.map((entry) => entry.name).sort(),
    ["get_stream_event_status", "list_stream_events"]);

  for (const [own, row, other] of [[alpha, a, b], [beta, b, a]]) {
    const list = (await message(await send("tools/call", { name: "list_stream_events", arguments: {} }, own))).result;
    const result = JSON.parse(list.content[0].text);
    assert.deepEqual(result.events.map(({ id }) => id), [row.id]);
    const status = (await message(await send("tools/call", {
      name: "get_stream_event_status", arguments: { id: row.id },
    }, own))).result;
    assert.deepEqual(Object.keys(JSON.parse(status.content[0].text)).sort(), ["createdAt", "ended", "id", "state", "title"]);
    const cross = (await message(await send("tools/call", {
      name: "get_stream_event_status", arguments: { id: other.id },
    }, own))).result;
    assert.equal(cross.isError, true);
    assert.deepEqual(JSON.parse(cross.content[0].text), { error: "not_found" });
  }
});
