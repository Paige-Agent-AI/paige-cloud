import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { initializeAccounts, openAccounts } from "./accounts.mjs";
import { initializeMembershipStore, openMembershipStore, openProjectCatalog, updateProjectMembership } from "./memberships.mjs";
import { createProjectAccess, firstProject, ownerId } from "./projects.mjs";
import { createOwnerServer } from "./server.mjs";
import { createStreamProvider } from "./media.mjs";

const origin = "https://owner.example.test";
const alias = "https://cloud.example.test";
const cloudDomain = "https://paigecloud.example.test";
const readFromGrants = (grants) => (principalId, organizationId, projectId) =>
  grants.some((grant) => grant.principalId === principalId &&
    grant.organizationId === organizationId && grant.projectId === projectId);

const ownerEmail = "owner@example.test";

test("provisions two isolated customer workspaces through an invitation at signup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "paige-customer-workspaces-"));
  const membershipPath = join(dir, "memberships.sqlite");
  const accountsPath = join(dir, "accounts.sqlite");
  initializeMembershipStore(membershipPath);
  initializeAccounts(accountsPath);
  const catalog = openProjectCatalog(membershipPath);
  const accounts = openAccounts(accountsPath, membershipPath);
  t.after(() => {
    accounts.close();
    catalog.close();
    unlinkSync(accountsPath);
    unlinkSync(membershipPath);
    rmdirSync(dir);
  });
  const password = "fixture customer workspace password";
  await accounts.create(ownerEmail, password, { owner: true });
  const access = createProjectAccess([{ ...firstProject, readStatus: async () => ({}), environments: {} }], catalog.hasProjectRead);
  const { request } = await startServer(t, access, ownerId, accounts, catalog);
  const post = (path, fields, cookie) => request(path, {
    method: "POST", headers: { origin, cookie: cookie ?? "", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  async function signIn(email) {
    const response = await post("/session", { email, password });
    assert.equal(response.status, 303);
    return { cookie: response.headers.get("set-cookie").split(";")[0], path: response.headers.get("location") };
  }
  const owner = await signIn(ownerEmail);
  const ownerProjects = owner.path.replace(/\/overview$/, "/projects");
  assert.match(await (await request(ownerProjects, { headers: { cookie: owner.cookie } })).text(), /Invite a customer/);
  async function invite(email) {
    const response = await post(ownerProjects, { action: "invite-customer", email, name: "First & best project" }, owner.cookie);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const code = (await response.text()).match(/<code class="account-id">([A-Za-z0-9_-]{43})<\/code>/)?.[1];
    assert.ok(code);
    return code;
  }
  const anna = "anna@example.test";
  const ben = "ben@example.test";
  const overlappingCode = accounts.issueInvitation(anna);
  const annaCode = await invite(anna);
  const benOldCode = await invite(ben);
  const benCode = await invite(ben);
  const cancelled = await invite("cancelled@example.test");
  assert.equal((await post(ownerProjects, { action: "cancel-customer", email: "cancelled@example.test" }, owner.cookie)).status, 303);
  assert.equal(catalog.list(ownerId).length, 1);
  for (const [email, invite] of [[ben, annaCode], [ben, benOldCode], ["cancelled@example.test", cancelled]]) {
    assert.equal((await post("/signup", { email, password, invite })).status, 400);
  }
  assert.equal(await accounts.create(anna, password, { code: overlappingCode }), false);
  const registered = await Promise.all([1, 2].map(() => post("/signup", { email: anna, password, invite: annaCode })));
  const [accepted, replay] = registered.sort((a, b) => a.status - b.status);
  assert.equal(accepted.status, 303);
  assert.ok([400, 409, 429].includes(replay.status));
  assert.equal(accepted.headers.get("location"), "/sign-in?signup=workspace");
  assert.equal((await post("/signup", { email: anna, password, invite: annaCode })).status, 400);

  const faultyStore = new DatabaseSync(membershipPath);
  try {
    faultyStore.exec(`CREATE TRIGGER deny_customer_grant BEFORE INSERT ON project_memberships
      WHEN NEW.organization_id LIKE 'org-%' BEGIN SELECT RAISE(ABORT, 'fixture grant failure'); END`);
    await assert.rejects(accounts.create(ben, password, { code: benCode, allowCustomerSignup: true }), /fixture grant failure/);
    assert.equal(await accounts.verify(ben, password), undefined);
    assert.equal(catalog.list(ownerId).length, 2);
    assert.equal(catalog.hasCustomerInvitation(ben, benCode), true);
    faultyStore.exec("DROP TRIGGER deny_customer_grant");
  } finally {
    faultyStore.close();
  }
  assert.equal((await post("/signup", { email: ben, password, invite: benCode })).status, 303);
  assert.equal(catalog.list(ownerId).length, 3);

  const a = await signIn(anna);
  const b = await signIn(ben);
  const projectPath = /^(\/accounts\/[1-9]\d{11})(\/projects\/(org-[a-f0-9]{32})\/(prj-[a-f0-9]{32}))$/;
  const aParts = projectPath.exec(a.path);
  const bParts = projectPath.exec(b.path);
  assert.ok(aParts && bParts);
  assert.notEqual(aParts[3], bParts[3]);
  assert.notEqual(aParts[4], bParts[4]);
  assert.match(await (await request(a.path, { headers: { cookie: a.cookie } })).text(), /First &amp; best project/);
  assert.equal((await request(aParts[1] + bParts[2], { headers: { cookie: a.cookie } })).status, 404);
  assert.equal((await request(a.path, { headers: { cookie: b.cookie } })).status, 404);
  assert.equal((await post(aParts[1] + "/projects", { action: "invite-customer", email: "third@example.test", name: "Other" }, a.cookie)).status, 404);
  assert.equal((await post(ownerProjects, { action: "invite-customer", email: anna, name: "Another workspace" }, owner.cookie)).status, 409);
  assert.equal((await request(aParts[1] + "/api/status", { headers: { cookie: a.cookie } })).status, 404);

  const reopenedCatalog = openProjectCatalog(membershipPath);
  const reopenedAccounts = openAccounts(accountsPath, membershipPath);
  try {
    const principal = await reopenedAccounts.verify(anna, password);
    assert.equal(reopenedCatalog.customerHome(principal).organizationId, aParts[3]);
    assert.equal(reopenedCatalog.list(principal).length, 1);
    assert.equal(reopenedAccounts.numberFor(principal), aParts[1].split("/").at(-1));
    assert.equal(reopenedCatalog.hasCustomerInvitation(anna, annaCode), false);
  } finally {
    reopenedAccounts.close();
    reopenedCatalog.close();
  }
});

test("backfills account numbers for existing credential records and preserves them on reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paige-account-numbers-"));
  const path = join(dir, "accounts.sqlite");
  try {
    initializeAccounts(path);
    const old = new DatabaseSync(path);
    try {
      old.exec("DROP TABLE account_numbers");
      const insert = old.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?)");
      insert.run(ownerId, ownerEmail, randomBytes(16), randomBytes(32));
      insert.run("member-legacy", "member@example.test", randomBytes(16), randomBytes(32));
    } finally {
      old.close();
    }
    const first = openAccounts(path);
    const numbers = [first.numberFor(ownerId), first.numberFor("member-legacy")];
    const rollingOldImage = new DatabaseSync(path);
    try {
      rollingOldImage.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?)")
        .run("member-during-roll", "rolling@example.test", randomBytes(16), randomBytes(32));
    } finally {
      rollingOldImage.close();
    }
    assert.equal(first.numberFor("member-during-roll"), undefined);
    const rollingNumber = first.ensureNumberFor("member-during-roll");
    assert.match(rollingNumber, /^[1-9][0-9]{11}$/);
    assert.equal(first.ensureNumberFor("unknown-principal"), undefined);
    first.close();
    for (const number of numbers) assert.match(number, /^[1-9][0-9]{11}$/);
    assert.notEqual(numbers[0], numbers[1]);
    const restarted = openAccounts(path);
    try {
      assert.deepEqual([restarted.numberFor(ownerId), restarted.numberFor("member-legacy")], numbers);
      assert.equal(restarted.numberFor("member-during-roll"), rollingNumber);
    } finally {
      restarted.close();
    }
  } finally {
    unlinkSync(path);
    rmdirSync(dir);
  }
});

async function startServer(t, projectAccess, principalId = ownerId, realAccounts, catalog, stream) {
  const password = randomBytes(32).toString("base64url");
  const key = randomBytes(32).toString("base64url");
  const server = createOwnerServer({
    origin, aliasOrigin: alias, additionalOrigins: [cloudDomain],
    passwordHash: createHash("sha256").update(key).digest("hex"),
    projectAccess,
    catalog,
    stream,
    accounts: realAccounts ?? {
      hasOwner: () => true,
      isOwnerEmail: (email) => principalId === ownerId && email === ownerEmail,
      verify: (email, supplied) => email === ownerEmail && supplied === password ? principalId : undefined,
    },
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
    body: "email=" + ownerEmail + "&password=" + secret,
  });
  return { request, login, password, key };
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
    body: "email=" + ownerEmail + "&password=" + password,
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
    body: "email=" + ownerEmail + "&password=" + password,
  });
  assert.equal(cloudLogin.status, 303);
  const cloudCookie = cloudLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/status", { headers: { host: cloudHost, cookie: cloudCookie } })).status, 200);
  assert.equal((await request("/api/status", { headers: { host: aliasHost, cookie: cloudCookie } })).status, 401);
  for (const page of ["/overview", "/deployments", "/domains", "/activity", "/deployments/release-123-1"]) {
    assert.match(await (await request(page, { headers: { cookie } })).text(), /href="\/deployments"/);
    assert.doesNotMatch(await (await request(page)).text(), /Deployment history/);
  }
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

test("one-time owner setup and invited signup persist with separate project access", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "paige-cloud-accounts-"));
  const path = join(directory, "accounts.sqlite");
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    unlinkSync(path);
    rmdirSync(directory);
  });
  assert.throws(() => openAccounts(path), { code: "ENOENT" });
  initializeAccounts(path);
  const accounts = openAccounts(path);
  stores.push(accounts);
  let reads = 0;
  const projectAccess = createProjectAccess([{
    ...firstProject,
    readStatus: async () => ({ reads: ++reads }),
    environments: {},
  }], (id) => id === ownerId);
  const { request, login, password, key } = await startServer(t, projectAccess, ownerId, accounts);
  const submit = (route, fields, source = origin) => request(route, {
    method: "POST",
    headers: { origin: source, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const member = { email: "member@example.test", password: "tulip 朱色 skyline for two" };
  const setup = { email: ownerEmail.toUpperCase(), password, key };
  assert.match(await (await request("/")).text(), /autocomplete="current-password"/);
  assert.equal((await request("/signup")).status, 404);
  assert.equal((await submit("/signup", member)).status, 404);
  assert.match(await (await request("/setup")).text(), /Owner key/);
  assert.equal((await submit("/setup", setup, alias)).status, 403);
  assert.equal((await submit("/setup", { ...setup, key: randomBytes(32).toString("base64url") })).status, 401);
  assert.equal((await submit("/setup", { ...setup, password: key })).status, 400);
  const createdOwner = await submit("/setup", setup);
  assert.equal(createdOwner.status, 303);
  assert.equal(createdOwner.headers.get("location"), "/sign-in?setup=complete");
  assert.equal(createdOwner.headers.get("set-cookie"), null);
  assert.equal((await request("/setup")).status, 404);
  assert.equal((await submit("/setup", setup)).status, 404);
  assert.equal((await submit("/session", { email: ownerEmail, password: key })).status, 401);
  const ownerCookie = (await login()).headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/status", { headers: { cookie: ownerCookie } })).status, 200);

  const signUpPage = await request("/signup");
  assert.match(await signUpPage.text(), /autocomplete="new-password"/);
  assert.equal((await submit("/signup", member)).status, 400);
  assert.throws(() => accounts.issueInvitation(ownerEmail), /already exists/);
  const oldInvitation = accounts.issueInvitation(member.email);
  const invitation = accounts.issueInvitation(member.email);
  const invited = { ...member, invite: invitation };
  assert.equal((await submit("/signup", { ...invited, invite: oldInvitation })).status, 400);
  assert.equal((await submit("/signup", { ...invited, email: ownerEmail })).status, 400);
  assert.equal((await submit("/signup", invited, alias)).status, 403);
  assert.equal((await submit("/signup", { ...invited, principal_id: ownerId })).status, 400);
  assert.equal((await submit("/signup", { ...invited, password: "a".repeat(513) })).status, 400);
  const created = await submit("/signup", invited);
  const duplicate = await submit("/signup", invited);
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("location"), "/sign-in?signup=complete");
  assert.equal(duplicate.status, 400);
  assert.equal((await submit("/session", { email: ownerEmail, password: member.password })).status, 401);
  const cookie = (await submit("/session", member)).headers.get("set-cookie").split(";")[0];
  const home = await (await request("/", { headers: { cookie } })).text();
  assert.match(home, /No projects yet/);
  const memberId = home.match(/member-[a-f0-9]{32}/)?.[0];
  assert.ok(memberId);
  assert.doesNotMatch(home, /Deployment history/);
  for (const route of ["/api/status", "/api/organizations/paige/projects/paige-agent-ai/status", "/assets/owner.js"]) {
    assert.equal((await request(route, { headers: { cookie } })).status, 404);
  }
  assert.equal(reads, 1);
  assert.equal((await submit("/session", member)).status, 303);
  assert.equal((await request("/sign-out", { method: "POST", headers: { origin, cookie } })).status, 303);
  assert.equal((await request("/api/status", { headers: { cookie } })).status, 401);

  // Running init again and opening a fresh server must preserve both stored accounts.
  initializeAccounts(path);
  const reopened = openAccounts(path);
  stores.push(reopened);
  assert.equal(await reopened.verify(member.email, member.password), memberId);
  const restarted = await startServer(t, projectAccess, ownerId, reopened);
  assert.equal((await restarted.request("/api/status", { headers: { cookie: ownerCookie } })).status, 401);
  const updatedLogin = await restarted.request("/session", {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: ownerEmail, password }).toString(),
  });
  const newOwnerCookie = updatedLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await restarted.request("/api/status", { headers: { cookie: newOwnerCookie } })).status, 200);
  assert.equal((await restarted.request("/setup")).status, 404);
});

test("ordinary sign-in traffic uses a separate budget from owner sign-in", async (t) => {
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  let active = 0;
  const accounts = {
    hasOwner: () => true,
    isOwnerEmail: (email) => email === ownerEmail,
    async verify(email) {
      if (email === ownerEmail) return ownerId;
      if (++active === 2) waiting.resolve();
      await release.promise;
    },
  };
  const { request, login, password } = await startServer(t, () => undefined, ownerId, accounts);
  const memberAttempt = () => request("/session", {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "member@example.test", password }).toString(),
  });
  const pending = [memberAttempt(), memberAttempt()];
  try {
    await waiting.promise;
    assert.equal((await memberAttempt()).status, 429);
    assert.equal((await login()).status, 303);
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
});

test("owner can manage two projects and invitations grant only the selected project", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "paige-project-console-"));
  const membershipPath = join(dir, "memberships.sqlite");
  const accountsPath = join(dir, "accounts.sqlite");
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    unlinkSync(accountsPath);
    unlinkSync(membershipPath);
    rmdirSync(dir);
  });
  initializeMembershipStore(membershipPath);
  initializeAccounts(accountsPath);
  const catalog = openProjectCatalog(membershipPath);
  const accounts = openAccounts(accountsPath, membershipPath);
  stores.push(accounts, catalog);
  const owner = { email: ownerEmail, password: "fixture owner password" };
  await accounts.create(owner.email, owner.password, { owner: true });
  const seen = [];
  const readers = ["amber", "violet"].map((organizationId) => ({
    organizationId, projectId: "demo",
    readStatus: async () => { seen.push(organizationId); return { organizationId }; },
    environments: { preview: async () => ({ organizationId }) },
  }));
  readers.push({ ...firstProject, readStatus: async () => ({ receipt: "fixture" }), environments: {} });
  const access = createProjectAccess(readers, catalog.hasProjectRead);
  let resolutions = 0;
  const { request } = await startServer(t, (...args) => { resolutions++; return access(...args); }, ownerId, accounts, catalog);
  const scopes = new Map();
  const scoped = (path, cookie) => cookie && scopes.has(cookie) && /^\/(projects|join|api)(?:\/|$)/.test(path)
    ? scopes.get(cookie) + path : path;
  const form = (path, fields, cookie, suppliedOrigin = origin) => request(scoped(path, cookie), {
    method: "POST", headers: { origin: suppliedOrigin, cookie: cookie ?? "", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const signIn = async (account) => {
    const response = await form("/session", account);
    assert.equal(response.status, 303);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const scope = response.headers.get("location").match(/^\/accounts\/[1-9][0-9]{11}(?=\/)/)?.[0];
    assert.ok(scope);
    scopes.set(cookie, scope);
    return cookie;
  };
  const ownerCookie = await signIn(owner);
  const at = (path, cookie) => request(scoped(path, cookie), { headers: { cookie } });
  const amber = "/projects/amber/demo";
  const violet = "/projects/violet/demo";
  const amberMembers = amber + "/members";
  const violetMembers = violet + "/members";
  const amberApi = "/api/organizations/amber/projects/demo";
  const violetApi = "/api/organizations/violet/projects/demo";
  assert.equal((await request("/projects")).status, 303);
  assert.equal((await form("/projects", { name: "Wrong origin", organization: "other", project: "demo" }, ownerCookie, alias)).status, 403);
  assert.equal((await request("/projects", { headers: { cookie: ownerCookie } })).headers.get("location"), scopes.get(ownerCookie) + "/projects");
  assert.equal((await form("/projects", { name: "Amber & <workspace>", organization: "amber", project: "demo" }, ownerCookie)).headers.get("location"), scopes.get(ownerCookie) + amber);
  assert.equal((await form("/projects", { name: "Violet", organization: "violet", project: "demo" }, ownerCookie)).headers.get("location"), scopes.get(ownerCookie) + violet);
  assert.equal((await form("/projects", { name: "Duplicate", organization: "violet", project: "demo" }, ownerCookie)).status, 409);
  assert.match(await (await at(amber, ownerCookie)).text(), /Amber &amp; &lt;workspace&gt;/);
  assert.equal((await form(amber, { action: "rename", name: "Amber Studio" }, ownerCookie)).status, 303);
  assert.equal((await form("/projects/paige/paige-agent-ai", { action: "archive" }, ownerCookie)).status, 400);
  assert.equal((await form("/projects/paige/paige-agent-ai", { action: "rename", name: "Rename canonical" }, ownerCookie)).status, 400);
  assert.ok((await (await at(amber, ownerCookie)).text()).includes(`href="${scopes.get(ownerCookie)}${amberMembers}"`));
  assert.equal((await form(amber, { action: "invite", email: "misrouted@example.test" }, ownerCookie)).status, 400);
  assert.equal((await form(amberMembers, { action: "invite", email: owner.email }, ownerCookie)).status, 400);
  const amberUser = { email: "amber@example.test", password: "fixture amber password" };
  const violetUser = { email: "violet@example.test", password: "fixture violet password" };
  async function issue(project, email) {
    const response = await form(project + "/members", { action: "invite", email }, ownerCookie);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Open email draft/);
    assert.match(page, /mailto:/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const code = page.match(/<code class="account-id">([A-Za-z0-9_-]{43})<\/code>/)?.[1];
    assert.ok(code);
    return code;
  }
  const amberCode = await issue(amber, amberUser.email);
  const violetCode = await issue(violet, violetUser.email);
  const revokedWhileRegistering = "revoked-pending@example.test";
  const cancelledCode = await issue(amber, revokedWhileRegistering);
  const pendingRegistration = accounts.create(revokedWhileRegistering, amberUser.password, {
    code: cancelledCode, allowProjectSignup: true,
  });
  catalog.cancelInvite("amber", "demo", revokedWhileRegistering);
  assert.equal(await pendingRegistration, false);
  assert.equal(await accounts.verify(revokedWhileRegistering, amberUser.password), undefined);
  assert.ok(!(await (await at(amberMembers, ownerCookie)).text()).includes(amberCode));
  assert.equal((await form("/signup", { ...amberUser, invite: violetCode })).status, 400);
  assert.equal((await form("/signup", { ...amberUser, invite: amberCode })).status, 303);
  assert.equal((await form("/signup", { ...violetUser, invite: violetCode })).status, 303);
  const amberCookie = await signIn(amberUser);
  const violetCookie = await signIn(violetUser);
  assert.equal((await at(amberApi + "/status", amberCookie)).status, 404);
  assert.equal((await form("/join", { invite: amberCode }, violetCookie)).status, 400);
  const joined = await Promise.all([form("/join", { invite: amberCode }, amberCookie), form("/join", { invite: amberCode }, amberCookie)]);
  assert.deepEqual(joined.map(({ status }) => status).sort(), [303, 400]);
  assert.equal(joined.find(({ status }) => status === 303).headers.get("location"), scopes.get(amberCookie) + amber);
  assert.equal((await form("/join", { invite: violetCode }, violetCookie)).headers.get("location"), scopes.get(violetCookie) + violet);
  assert.equal((await form("/join", { invite: amberCode }, amberCookie)).status, 400);
  assert.match(await (await at("/projects", amberCookie)).text(), /Amber Studio/);
  assert.doesNotMatch(await (await at("/projects", amberCookie)).text(), /Violet/);
  assert.equal((await at(violet, amberCookie)).status, 404);
  assert.equal((await at(amber, violetCookie)).status, 404);
  assert.equal((await at(amberMembers, amberCookie)).status, 404);
  assert.equal((await at(violetMembers, amberCookie)).status, 404);
  assert.equal((await form(amberMembers, { action: "invite", email: "uninvited@example.test" }, amberCookie)).status, 404);
  assert.equal((await at(amberApi + "/status", violetCookie)).status, 404);
  assert.equal((await at(violetApi + "/environments/preview/status", amberCookie)).status, 404);
  assert.deepEqual(await (await at(amberApi + "/status", amberCookie)).json(), { organizationId: "amber" });
  assert.deepEqual(await (await at(violetApi + "/status", violetCookie)).json(), { organizationId: "violet" });
  assert.deepEqual(seen, ["amber", "violet"]);
  assert.doesNotMatch(await (await at(amber, amberCookie)).text(), /Invite by email|Revoke access|amber@example.test/);
  const amberId = await accounts.verify(amberUser.email, amberUser.password);
  for (const [cookie, principal] of [[amberCookie, amberId], [ownerCookie, ownerId]]) {
    if (principal !== ownerId) updateProjectMembership(membershipPath, "grant", principal, "paige", "paige-agent-ai");
    assert.deepEqual(await (await at("/api/status", cookie)).json(), { receipt: "fixture" });
  }
  const beforeCrossing = resolutions;
  const ownerPath = scopes.get(ownerCookie);
  const amberPath = scopes.get(amberCookie);
  assert.notEqual(ownerPath, amberPath);
  for (const [cookie, otherPath] of [[ownerCookie, amberPath], [amberCookie, ownerPath]]) {
    for (const path of ["/overview", "/deployments", "/projects", amberMembers, "/api/status"]) {
      assert.equal((await request(otherPath + path, { headers: { cookie } })).status, 404);
    }
    assert.equal((await form(otherPath + amberMembers, { action: "invite", email: "wrong-scope@example.test" }, cookie)).status, 404);
  }
  assert.equal((await request("/accounts/000000000000/projects", { headers: { cookie: ownerCookie } })).status, 404);
  assert.equal(resolutions, beforeCrossing);
  const reopenedAccounts = openAccounts(accountsPath, membershipPath);
  stores.push(reopenedAccounts);
  assert.equal("/accounts/" + reopenedAccounts.numberFor(amberId), amberPath);
  assert.equal("/accounts/" + reopenedAccounts.numberFor(ownerId), ownerPath);
  const waiting = await issue(amber, amberUser.email);
  assert.equal((await form(amberMembers, { action: "revoke", member: amberId }, ownerCookie)).headers.get("location"), ownerPath + amberMembers);
  assert.equal((await at(amberApi + "/status", amberCookie)).status, 404);
  assert.equal((await at(amber, amberCookie)).status, 404);
  assert.equal((await form("/join", { invite: waiting }, amberCookie)).status, 400);
  assert.equal((await at(violetApi + "/status", violetCookie)).status, 200);
  const pending = await issue(violet, "cancelled@example.test");
  assert.equal((await form(violet, { action: "archive" }, ownerCookie)).status, 303);
  assert.equal((await at(violetApi + "/status", violetCookie)).status, 404);
  assert.equal((await form(violet, { action: "restore" }, ownerCookie)).status, 303);
  assert.equal((await at(violetApi + "/status", violetCookie)).status, 200);
  assert.equal(catalog.hasInvitation("cancelled@example.test", pending), false);
  const violetId = await accounts.verify(violetUser.email, violetUser.password);
  const pendingAfterCli = await issue(violet, violetUser.email);
  assert.equal(updateProjectMembership(membershipPath, "revoke", violetId, "violet", "demo"), true);
  assert.equal((await form("/join", { invite: pendingAfterCli }, violetCookie)).status, 400);
  assert.equal((await at(violetApi + "/status", violetCookie)).status, 404);
  assert.equal((await request("/assets/project-session.js")).status, 404);
  assert.match(await (await at(amber, ownerCookie)).text(), /project-session\.js/);
  assert.match(await (await at("/assets/project-session.js", ownerCookie)).text(), /paige-owner-session/);
  const reopened = openProjectCatalog(membershipPath);
  stores.push(reopened);
  assert.equal(reopened.get({ organizationId: "amber", projectId: "demo" }).name, "Amber Studio");
  assert.equal(reopened.hasProjectRead(amberId, "amber", "demo"), false);
  assert.equal(reopened.hasProjectRead(ownerId, "paige", "paige-agent-ai"), true);
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

test("project Media keeps one signed live video and replay in its account", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "paige-media-"));
  const membership = join(dir, "memberships.sqlite");
  const account = join(dir, "accounts.sqlite");
  initializeMembershipStore(membership);
  initializeAccounts(account);
  const catalog = openProjectCatalog(membership);
  const accounts = openAccounts(account, membership);
  t.after(() => {
    accounts.close();
    catalog.close();
    unlinkSync(account);
    unlinkSync(membership);
    rmdirSync(dir);
  });

  const input = "1".repeat(32);
  const providerAccount = "2".repeat(32);
  const videoId = "3".repeat(32);
  const secondVideo = "4".repeat(32);
  const playbackHost = "customer-fixture.cloudflarestream.com";
  const signed = "test.token.signature";
  let privacy = false;
  let videoState = "waiting";
  const reads = [];
  const media = createStreamProvider({ account: providerAccount, token: "fixture-stream-secret", host: playbackHost }, async (url, options) => {
    const path = new URL(url).pathname.split("/stream").at(-1);
    assert.equal(options.headers.Authorization, "Bearer fixture-stream-secret");
    assert.equal(options.redirect, "error");
    reads.push(path);
    const result = path === "/live_inputs/" + input ? {
      uid: input, recording: { requireSignedURLs: privacy, mode: "automatic" }, rtmps: { streamKey: "private-ingest-key" },
    } : path === "/live_inputs/" + input + "/videos" ? videoState === "waiting" ? [] : [
      { uid: secondVideo, created: new Date(Date.now() + 1000).toISOString() },
      { uid: videoId, created: new Date().toISOString() },
    ] : path === "/" + videoId ? {
      uid: videoId, requireSignedURLs: privacy, readyToStream: videoState === "ready", status: { state: videoState },
    } : path === "/" + videoId + "/token" ? { token: signed } : undefined;
    assert.notEqual(result, undefined, path);
    if (path.endsWith("/token")) {
      assert.equal(options.method, "POST");
      assert.ok(JSON.parse(options.body).exp <= Math.floor(Date.now() / 1000) + 1801);
    }
    return Response.json({ success: true, result });
  });

  const password = "fixture Media project password";
  await accounts.create(ownerEmail, password, { owner: true });
  const access = createProjectAccess([{ ...firstProject, readStatus: async () => ({}), environments: {} }], catalog.hasProjectRead);
  const { request, login } = await startServer(t, access, ownerId, accounts, catalog, media);
  const owner = await login(password);
  assert.equal(owner.status, 303);
  const cookie = owner.headers.get("set-cookie").split(";")[0];
  const accountPath = owner.headers.get("location").replace(/\/overview$/, "");
  const root = accountPath + "/projects/paige/paige-agent-ai/media";
  const get = (path) => request(path, { headers: { cookie } });
  const post = (path, target = origin) => request(path, {
    method: "POST", headers: { cookie, origin: target, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: "Private <event>", input }).toString(),
  });
  assert.equal((await request(root)).status, 303);
  assert.equal((await post(root, "https://unrelated.example")).status, 403);
  assert.equal((await post(root)).status, 400);
  privacy = true;
  assert.equal((await request(root, { headers: { cookie: "" } })).status, 303);
  const registered = await post(root);
  assert.equal(registered.status, 303);
  const path = registered.headers.get("location");
  assert.ok(path.startsWith(root + "/"));
  assert.equal((await post(root)).status, 409);
  const waiting = await get(path);
  assert.match(await waiting.text(), /Waiting for broadcast/);
  assert.ok(!waiting.headers.get("content-security-policy").includes("frame-src"));
  assert.equal((await get(path.replace(accountPath, "/accounts/123456789012"))).status, 404);

  videoState = "live-inprogress";
  const live = await get(path);
  const livePage = await live.text();
  assert.match(livePage, /<h2>Live<\/h2>/);
  assert.match(livePage, /Private &lt;event&gt;/);
  assert.ok(livePage.includes("https://" + playbackHost + "/" + signed + "/iframe"));
  assert.ok(!livePage.includes("private-ingest-key"));
  assert.ok(live.headers.get("content-security-policy").includes("frame-src https://" + playbackHost));

  videoState = "ready";
  const resumedCatalog = openProjectCatalog(membership);
  try {
    assert.equal(resumedCatalog.stream(firstProject, path.split("/").at(-1)).videoId, videoId);
  } finally { resumedCatalog.close(); }
  assert.match(await (await get(path)).text(), /<h2>Replay<\/h2>/);
  privacy = false;
  const unavailable = await get(path);
  assert.match(await unavailable.text(), /Playback unavailable/);
  assert.ok(!unavailable.headers.get("content-security-policy").includes("frame-src"));
  privacy = true;
  const email = "media-member@example.test";
  const invite = catalog.issue(firstProject.organizationId, firstProject.projectId, email);
  assert.ok(await accounts.create(email, password, { code: invite, allowProjectSignup: true }));
  const memberId = await accounts.verify(email, password);
  assert.ok(catalog.accept(memberId, email, invite));
  const signedIn = await request("/session", {
    method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }).toString(),
  });
  const memberPath = signedIn.headers.get("location").replace(/\/overview$/, "");
  const memberCookie = signedIn.headers.get("set-cookie").split(";")[0];
  const memberEvent = path.replace(accountPath, memberPath);
  const memberGet = (url) => request(url, { headers: { cookie: memberCookie } });
  assert.match(await (await memberGet(memberEvent)).text(), /<h2>Replay<\/h2>/);
  const share = path.slice(accountPath.length);
  const shared = await memberGet(share);
  assert.equal(shared.status, 303);
  assert.equal(shared.headers.get("location"), memberEvent);
  assert.ok(livePage.includes('href="' + share + '">Member watch link'));
  assert.equal((await request(root.replace(accountPath, memberPath), {
    method: "POST", headers: { cookie: memberCookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: "Member mutation", input }).toString(),
  })).status, 404);
  const before = reads.length;
  assert.equal((await memberGet(path)).status, 404);
  assert.equal((await get(path.replace("/paige/paige-agent-ai/", "/other/project/"))).status, 404);
  catalog.revoke(firstProject.organizationId, firstProject.projectId, memberId, email);
  assert.equal((await memberGet(memberEvent)).status, 404);
  assert.equal(reads.length, before);
});
