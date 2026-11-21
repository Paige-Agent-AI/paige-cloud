import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { initializeMembershipStore, openMembershipStore, updateProjectMembership } from "./memberships.mjs";
import { createProjectAccess, firstProject, ownerId } from "./projects.mjs";
import { createOwnerServer } from "./server.mjs";

const origin = "https://owner.example.test";
const alias = "https://cloud.example.test";
const cloudDomain = "https://paigecloud.example.test";
const readFromGrants = (grants) => (principalId, organizationId, projectId) =>
  grants.some((grant) => grant.principalId === principalId &&
    grant.organizationId === organizationId && grant.projectId === projectId);

async function startServer(t, projectAccess, principalId = ownerId) {
  const password = randomBytes(32).toString("base64url");
  const server = createOwnerServer({
    origin, aliasOrigin: alias, additionalOrigins: [cloudDomain],
    passwordHash: createHash("sha256").update(password).digest("hex"),
    projectAccess, principalId,
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
  const login = (secret = password, suppliedOrigin = origin) => request("/session", {
    method: "POST", headers: { origin: suppliedOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: "password=" + secret,
  });
  return { request, login, password };
}

test("owner HTTP surface gates assets and data, rejects tampering, and invalidates logout", async (t) => {
  let reads = 0;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const firstProject = { organizationId: "paige", projectId: "paige-agent-ai" };
  const projectAccess = createProjectAccess([{
    ...firstProject,
    readStatus: async () => { reads++; return { value: "verified-owner-only" }; },
    environments: {},
  }], readFromGrants([{ principalId: ownerId, ...firstProject }]));
  const { request, login, password } = await startServer(t, projectAccess);
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
  const cloudHost = new URL(cloudDomain).host;
  assert.equal((await request("/api/status", { headers: { host: cloudHost, cookie: aliasCookie } })).status, 401);
  const cloudLogin = await request("/session", {
    method: "POST",
    headers: { host: cloudHost, origin: cloudDomain, "content-type": "application/x-www-form-urlencoded" },
    body: "password=" + password,
  });
  assert.equal(cloudLogin.status, 303);
  const cloudCookie = cloudLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/status", { headers: { host: cloudHost, cookie: cloudCookie } })).status, 200);
  assert.equal((await request("/api/status", { headers: { host: aliasHost, cookie: cloudCookie } })).status, 401);
  assert.equal((await request("/api/status", { headers: { cookie: cookie.slice(0, -1) + "?" } })).status, 401);
  const [first, second] = await Promise.all([
    request("/api/status", { headers: { cookie } }),
    request("/api/organizations/paige/projects/paige-agent-ai/status", { headers: { cookie } }),
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

test("project status checks organization and project grants before reading environment data", async (t) => {
  const reads = [];
  const makeReader = (value) => async () => {
    reads.push(value);
    return { value };
  };
  const studio = { organizationId: "studio", projectId: "website" };
  const labs = { organizationId: "labs", projectId: "website" };
  const studioInternal = { organizationId: "studio", projectId: "internal" };
  const projects = [studio, labs, studioInternal].map((project) => {
    const label = `${project.organizationId}/${project.projectId}`;
    return {
      ...project,
      readStatus: makeReader(label),
      environments: { production: makeReader(label + "/production"), preview: makeReader(label + "/preview") },
    };
  });
  const access = createProjectAccess(projects, readFromGrants([
    { principalId: "studio-owner", ...studio },
    { principalId: "labs-owner", ...labs },
    { principalId: "observer", ...studio },
    { principalId: "observer", ...labs },
  ]));
  const studioServer = await startServer(t, access, "studio-owner");
  const labsServer = await startServer(t, access, "labs-owner");
  const studioPath = "/api/organizations/studio/projects/website";
  const labsPath = "/api/organizations/labs/projects/website";
  const internalPath = "/api/organizations/studio/projects/internal";
  const production = "/environments/production/status";
  const preview = "/environments/preview/status";
  assert.equal((await studioServer.request(studioPath + production)).status, 401);
  const studioCookie = (await studioServer.login()).headers.get("set-cookie").split(";")[0];
  const labsCookie = (await labsServer.login()).headers.get("set-cookie").split(";")[0];
  const studioGet = (path, headers = {}) => studioServer.request(path, {
    headers: { cookie: studioCookie, ...headers },
  });
  const labsGet = (path) => labsServer.request(path, { headers: { cookie: labsCookie } });

  const denied = await studioGet(labsPath + production, { "x-principal-id": "labs-owner", "x-organization-id": "labs" });
  const missing = await studioGet(studioPath + "/environments/unknown/status");
  assert.equal(denied.status, 404);
  assert.equal(missing.status, denied.status);
  assert.equal(await denied.text(), await missing.text());
  assert.equal((await studioGet(internalPath + "/status")).status, 404);
  assert.equal((await studioGet("/api/status")).status, 404);
  assert.equal((await studioGet(studioPath + "/environments/%70roduction/status")).status, 404);
  assert.deepEqual(reads, []);

  const observed = [
    await studioGet(studioPath + production),
    await studioGet(studioPath + preview),
    await labsGet(labsPath + production),
    await studioGet(studioPath + production),
  ];
  for (const response of observed) assert.equal(response.status, 200);
  assert.deepEqual(await Promise.all(observed.map((r) => r.json())), [
    { value: "studio/website/production" },
    { value: "studio/website/preview" },
    { value: "labs/website/production" },
    { value: "studio/website/production" },
  ]);
  assert.equal((await labsGet(studioPath + production)).status, 404);
  assert.equal((await studioGet(labsPath + production)).status, 404);
  assert.deepEqual(reads, ["studio/website/production", "studio/website/preview", "labs/website/production"]);

  const observer = await startServer(t, access, "observer");
  const observerCookie = (await observer.login()).headers.get("set-cookie").split(";")[0];
  const observerGet = (path) => observer.request(path + production, { headers: { cookie: observerCookie } });
  const simultaneous = await Promise.all([observerGet(studioPath), observerGet(labsPath), observerGet(studioPath)]);
  for (const response of simultaneous) assert.equal(response.status, 200);
  assert.deepEqual(await Promise.all(simultaneous.map((r) => r.json())), [
    { value: "studio/website/production" },
    { value: "labs/website/production" },
    { value: "studio/website/production" },
  ]);
  assert.deepEqual(reads.slice(3).sort(), ["labs/website/production", "studio/website/production"]);
});

test("persistent revocation denies warm and pending reads and survives initialization and restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "paige-cloud-memberships-"));
  const path = join(dir, "memberships.sqlite");
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  let store;
  t.after(() => {
    pending.resolve({ value: "delayed" });
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { organizationId, projectId } = firstProject;
  const change = (action, principal = ownerId, org = organizationId) =>
    updateProjectMembership(path, action, principal, org, projectId);
  const unknownFile = join(dir, "other.sqlite");
  writeFileSync(unknownFile, "");
  assert.throws(() => initializeMembershipStore(unknownFile), /Unrecognized Cloud membership database/);
  assert.equal(readFileSync(unknownFile).length, 0);
  assert.throws(() => openMembershipStore(path));
  assert.throws(() => change("grant"));
  assert.equal(initializeMembershipStore(path), true);
  assert.equal(initializeMembershipStore(path), false);
  assert.throws(() => change("grant", ownerId, "unknown"), /FOREIGN KEY/);

  // Both organizations use the same project ID, which remains an exact tuple lookup.
  const fixture = new DatabaseSync(path);
  try {
    fixture.prepare("INSERT INTO projects VALUES (?, ?)").run("studio", projectId);
  } finally {
    fixture.close();
  }
  assert.equal(change("grant", "studio-owner", "studio"), true);
  assert.equal(change("grant", "studio-owner", "studio"), false);
  store = openMembershipStore(path);
  assert.equal(store.hasProjectRead("studio-owner", organizationId, projectId), false);
  assert.equal(store.hasProjectRead("studio-owner", "studio", projectId), true);
  assert.equal(store.hasProjectRead(ownerId, "studio", projectId), false);
  assert.equal(store.hasProjectRead("CLOUD-OWNER", organizationId, projectId), false);

  let reads = 0;
  const projects = [{
    ...firstProject,
    readStatus: () => { reads++; return { value: "cached" }; },
    environments: { preview: () => { started.resolve(); return pending.promise; } },
  }];
  const fixtureServer = await startServer(t, createProjectAccess(projects, store.hasProjectRead));
  const cookie = (await fixtureServer.login()).headers.get("set-cookie").split(";")[0];
  const options = { headers: { cookie } };
  const projectPath = `/api/organizations/${organizationId}/projects/${projectId}`;
  assert.equal((await fixtureServer.request(projectPath + "/status", options)).status, 200);
  const delayed = fixtureServer.request(projectPath + "/environments/preview/status", options);
  await started.promise;

  assert.equal(change("revoke"), true);
  assert.equal(change("revoke"), false);
  assert.equal((await fixtureServer.request("/api/status", options)).status, 404);
  pending.resolve({ value: "private" });
  assert.equal((await delayed).status, 404);
  assert.equal(reads, 1);
  assert.equal(initializeMembershipStore(path), false);
  assert.equal(store.hasProjectRead(ownerId, organizationId, projectId), false);

  store.close();
  store = openMembershipStore(path);
  const restartedServer = await startServer(t, createProjectAccess(projects, store.hasProjectRead));
  const restartedCookie = (await restartedServer.login()).headers.get("set-cookie").split(";")[0];
  const restartedOptions = { headers: { cookie: restartedCookie } };
  assert.equal((await restartedServer.request(projectPath + "/status", restartedOptions)).status, 404);
  assert.equal(change("grant"), true);
  assert.equal((await restartedServer.request(projectPath + "/status", restartedOptions)).status, 200);
});
