import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { createPilotServer } from "./server.mjs";
import { createSupabasePilot } from "./supabase.mjs";

const origin = "https://pilot.example.test";
const evaluator = {
  id: "12345678-1111-2222-3333-123456789abc", email: "evaluator@example.test",
  tenant: "12345678-1111-2222-3333-223456789abc", role: "member",
};
const workspace = { email: evaluator.email, workspace: "Evaluator workspace", role: "member" };
const signedToken = (claims = {}) => `header.${Buffer.from(JSON.stringify({
  sub: evaluator.id, role: "authenticated", session_id: "12345678-1111-2222-3333-323456789abc", ...claims,
})).toString("base64url")}.signature`;

async function listen(t, config = {}) {
  const key = randomBytes(32).toString("base64url");
  const server = createPilotServer({
    origin, keyHash: createHash("sha256").update(key).digest("hex"), index: "PAIGE sign-in",
    assets: new Map([["/assets/pilot.js", ["text/javascript", "// bundle"]]]), release: "{}", ...config,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });

  function call(path, { method = "GET", cookie, type, body, suppliedOrigin = origin } = {}) {
    const headers = { host: "pilot.example.test", "x-forwarded-proto": "https", origin: suppliedOrigin };
    if (cookie) headers.cookie = cookie;
    if (type) headers["content-type"] = type;
    return new Promise((resolve, reject) => {
      const outgoing = request(`http://127.0.0.1:${server.address().port}${path}`, { method, headers }, (incoming) => {
        const chunks = [];
        incoming.on("data", (part) => chunks.push(part));
        incoming.on("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString() }));
        incoming.on("error", reject);
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }

  async function unlock(suppliedKey = key) {
    return call("/gate", { method: "POST", type: "application/x-www-form-urlencoded", body: "key=" + suppliedKey });
  }
  return { call, unlock };
}

const cookieFrom = (reply) => reply.headers["set-cookie"][0].split(";")[0];
const credentials = (cookie, email = evaluator.email) => ({
  method: "POST", cookie, type: "application/json", body: JSON.stringify({ email, password: "synthetic-password" }),
});

test("gate denies anonymous assets and protected routes, and disabled auth makes no backend call", async (t) => {
  const backend = { signIn: t.mock.fn() };
  const { call, unlock } = await listen(t, { backend });
  assert.equal((await call("/healthz")).status, 200);
  for (const path of ["/auth", "/choose-account", "/release.json", "/assets/pilot.js", "/api/account"]) {
    assert.equal((await call(path)).status, 401, path);
  }
  assert.equal((await call("/auth")).headers["referrer-policy"], "same-origin");
  assert.equal((await unlock("wrong-key")).status, 401);
  const gate = await unlock();
  assert.equal(gate.status, 303);
  assert.match(gate.headers["set-cookie"][0], /; Secure; HttpOnly; SameSite=Strict; Max-Age=1800$/);
  const cookie = cookieFrom(gate);
  assert.equal((await call("/auth?mode=login", { cookie })).body, "PAIGE sign-in");
  assert.equal((await call("/assets/pilot.js", { cookie })).status, 200);
  assert.equal((await call("/api/sign-in", credentials(cookie))).status, 423);
  assert.equal((await call("/choose-account", { cookie })).headers.location, "/auth?mode=login");
  assert.equal((await call("/auth?mode=signup", { cookie })).status, 404);
  assert.equal(backend.signIn.mock.calls.length, 0);
});

test("one approved identity persists through reload and remains signed in until upstream confirms local logout", async (t) => {
  let allowLogout = false;
  const backend = {
    signIn: t.mock.fn(async () => ({ access_token: signedToken(), user: { id: evaluator.id }, expires_in: 3600 })),
    account: t.mock.fn(async () => workspace), signOut: t.mock.fn(async () => allowLogout),
  };
  const now = Date.now();
  const { call, unlock } = await listen(t, { backend, evaluator, now: () => now });
  const gate = cookieFrom(await unlock());
  assert.equal((await call("/api/sign-in", credentials(gate, "another@example.test"))).status, 401);
  assert.equal((await call("/api/sign-in", { ...credentials(gate), suppliedOrigin: "https://another.example.test" })).status, 403);
  assert.equal(backend.signIn.mock.calls.length, 0);

  const accepted = await call("/api/sign-in", credentials(gate));
  assert.equal(accepted.status, 204);
  assert.match(accepted.headers["set-cookie"][0], /; Secure; HttpOnly; SameSite=Strict; Max-Age=900$/);
  const session = cookieFrom(accepted);
  assert.ok(!JSON.stringify(accepted).includes(signedToken()));
  assert.equal((await call("/api/account", { cookie: session })).status, 401);
  const cookie = `${gate}; ${session}`;
  for (let load = 0; load < 2; load++) {
    assert.equal((await call("/choose-account", { cookie })).status, 200);
    assert.deepEqual(JSON.parse((await call("/api/account", { cookie })).body), workspace);
  }
  assert.equal((await call("/api/sign-in", credentials(gate))).status, 409);
  assert.equal((await call("/rest/v1/profiles", { method: "PATCH", cookie })).status, 404);
  assert.equal((await call("/functions/v1/check-subscription", { method: "POST", cookie })).status, 404);
  assert.equal((await call("/api/sign-out", { method: "POST", cookie })).status, 502);
  assert.equal((await call("/api/account", { cookie })).status, 200);

  allowLogout = true;
  const ended = await call("/api/sign-out", { method: "POST", cookie });
  assert.equal(ended.status, 204);
  assert.match(ended.headers["set-cookie"][0], /Max-Age=0$/);
  assert.equal((await call("/api/account", { cookie })).status, 401);
  assert.equal((await call("/choose-account", { cookie })).headers.location, "/auth?mode=login");
});

test("rejects invalid subject or absent session ID without allowing logout to revoke other sessions", async (t) => {
  let claims;
  const backend = {
    signIn: async () => ({ access_token: signedToken(claims), user: { id: evaluator.id }, expires_in: 3600 }),
    account: t.mock.fn(), signOut: t.mock.fn(),
  };
  const { call, unlock } = await listen(t, { backend, evaluator });
  const gate = cookieFrom(await unlock());
  for (claims of [{ sub: "another-user" }, { session_id: undefined },
    { session_id: ["12345678-1111-2222-3333-323456789abc"] }, { session_id: "00000000-0000-0000-0000-000000000000" }]) {
    assert.equal((await call("/api/sign-in", credentials(gate))).status, 403);
  }
  assert.equal(backend.account.mock.calls.length, 0);
  assert.equal(backend.signOut.mock.calls.length, 0);
});

test("Supabase adapter forwards the evaluator token to the fixed Auth and RLS read endpoints only", async () => {
  const calls = [];
  const audit = [];
  let memberships = [{ tenant_id: evaluator.tenant, role: evaluator.role }];
  const backend = createSupabasePilot("sb_publishable_test", (event) => audit.push(event), async (target, options) => {
    const url = new URL(target);
    calls.push({ url, options });
    switch (url.pathname) {
      case "/auth/v1/token": return Response.json({ access_token: "server-only-token" });
      case "/auth/v1/user": return Response.json({ id: evaluator.id, email: evaluator.email });
      case "/rest/v1/tenant_members": return Response.json(memberships);
      case "/rest/v1/tenants": return Response.json([{ id: evaluator.tenant, name: workspace.workspace }]);
      case "/rest/v1/rpc/is_platform_admin":
      case "/rest/v1/rpc/is_platform_owner": return Response.json(false);
      case "/auth/v1/logout": return new Response(null, { status: 204 });
      default: throw new Error("Unexpected outbound request");
    }
  });
  await backend.signIn(evaluator.email, "synthetic-password");
  assert.deepEqual(await backend.account("server-only-token", evaluator), workspace);
  assert.equal(await backend.signOut("server-only-token"), true);
  assert.equal(calls[0].url.search, "?grant_type=password");
  assert.equal(calls.at(-1).url.search, "?scope=local");
  assert.ok(calls.every(({ url, options }) => url.origin === "https://xygzykjyynhzqytbqnzu.supabase.co" && options.redirect === "error"));
  assert.ok(calls.slice(1).every(({ options }) => options.headers.Authorization === "Bearer server-only-token"));
  assert.ok(audit.every(({ operation }) => !operation.includes("?")));
  assert.equal(audit.length, 7);
  memberships = [{ tenant_id: "another-workspace", role: evaluator.role }];
  assert.equal(await backend.account("server-only-token", evaluator), null);
  assert.ok(!calls.slice(7).some(({ url }) => url.pathname === "/rest/v1/tenants"));
});
