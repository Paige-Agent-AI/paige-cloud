import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { createOwnerServer } from "./server.mjs";

test("owner HTTP surface gates assets and data, rejects tampering, and invalidates logout", async (t) => {
  const origin = "https://owner.example.test";
  const alias = "https://cloud.example.test";
  const password = randomBytes(32).toString("base64url");
  let reads = 0;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const server = createOwnerServer({
    origin, aliasOrigin: alias, passwordHash: createHash("sha256").update(password).digest("hex"),
    token: "fake-runtime-read-token", statusReader: async () => { reads++; return { value: "verified-owner-only" }; },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest(base + path, { method, headers: { host: "owner.example.test", "x-forwarded-proto": "https", ...headers } }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), {
        status: incoming.statusCode, headers: incoming.headers,
      })));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
  const status = () => request("/api/status");
  assert.equal((await status()).status, 401);
  assert.equal((await request("/assets/owner.js")).status, 404);
  const lock = await request("/");
  assert.equal(lock.status, 200);
  assert.ok(!(await lock.text()).includes("verified-owner-only"));
  assert.match(lock.headers.get("cache-control"), /no-store/);
  assert.match(lock.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await request("/api/status", { headers: { host: "another.example.test" } })).status, 421);
  assert.equal((await request("/api/status", { method: "POST" })).status, 405);
  const transport = await request("/api/status", { headers: { "x-forwarded-proto": "http" } });
  assert.equal(transport.status, 308);
  assert.equal(transport.headers.get("location"), origin + "/");
  assert.equal(reads, 0);

  const login = (secret, suppliedOrigin = origin) => request("/session", {
    method: "POST", headers: { origin: suppliedOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: "password=" + secret,
  });
  assert.equal((await login(password, "https://evil.example")).status, 403);
  assert.equal((await login(randomBytes(32).toString("base64url"))).status, 401);
  assert.equal((await login(password + "&password=" + password)).status, 401);

  const signedIn = await login(password);
  const setCookie = signedIn.headers.get("set-cookie");
  assert.equal(signedIn.status, 303);
  assert.match(setCookie, /^__Host-paige_owner=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800$/);
  const cookie = setCookie.split(";")[0];
  const aliasHost = new URL(alias).host;
  const atAlias = { host: aliasHost, cookie };
  assert.equal((await request("/api/status", { headers: atAlias })).status, 401);
  assert.equal((await request("/sign-out", { method: "POST", headers: { ...atAlias, origin } })).status, 403);
  const aliasLogin = await request("/session", {
    method: "POST",
    headers: { host: aliasHost, origin: alias, "content-type": "application/x-www-form-urlencoded" },
    body: "password=" + password,
  });
  assert.equal(aliasLogin.status, 303);
  const aliasCookie = aliasLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/status", { headers: { cookie: aliasCookie } })).status, 401);
  assert.equal((await request("/api/status", { headers: { host: aliasHost, cookie: aliasCookie } })).status, 200);
  assert.equal((await request("/api/status", { headers: { cookie: cookie.slice(0, -1) + "?" } })).status, 401);
  const [first, second] = await Promise.all([
    request("/api/status", { headers: { cookie } }), request("/api/status", { headers: { cookie } }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), { value: "verified-owner-only" });
  assert.equal(reads, 1);
  assert.equal(Date.parse(first.headers.get("x-owner-session-expires-at")), now + 1_800_000);
  assert.equal((await request("/assets/owner.js", { headers: { cookie } })).status, 200);
  const signedOut = await request("/sign-out", { method: "POST", headers: { cookie, origin } });
  assert.equal(signedOut.status, 303);
  assert.match(signedOut.headers.get("set-cookie"), /Max-Age=0$/);
  assert.equal((await request("/api/status", { headers: { cookie } })).status, 401);
  const signedInAgain = await login(password);
  const nextCookie = signedInAgain.headers.get("set-cookie").split(";")[0];
  now += 1_800_000;
  assert.equal((await request("/api/status", { headers: { cookie: nextCookie } })).status, 401);
});
