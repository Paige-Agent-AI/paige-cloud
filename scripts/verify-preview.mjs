import assert from "node:assert/strict";

const [base, cloudCommit, frontendCommit] = process.argv.slice(2);
assert.match(cloudCommit ?? "", /^[a-f0-9]{40}$/);
assert.match(frontendCommit ?? "", /^[a-f0-9]{40}$/);
const origin = new URL(base);
assert.ok(origin.protocol === "https:" || origin.hostname === "127.0.0.1");
const buildId = `${frontendCommit}-${cloudCommit}`;

async function request(path, status = 200, options = {}) {
  const response = await fetch(new URL(path, origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    ...options,
  });
  assert.equal(response.status, status, path);
  const csp = response.headers.get("content-security-policy");
  const policy = new Map(csp?.split(";").map((entry) => {
    const [directive, ...values] = entry.trim().split(/\s+/);
    return [directive, values.join(" ")];
  }));
  for (const [directive, value] of [
    ["connect-src", "'self'"], ["form-action", "'none'"], ["worker-src", "'none'"],
    ["frame-src", "'none'"], ["object-src", "'none'"],
  ]) {
    assert.equal(policy.get(directive), value, `${path} ${directive}`);
  }
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", path);
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(), path, status,
    cacheControl: response.headers.get("cache-control"),
  }));
  return response;
}

const health = await request("/healthz");
assert.match(health.headers.get("content-type") ?? "", /^text\/plain(?:;[^,]+)?$/);
assert.equal(await health.text(), "ok\n");
const version = await request("/version.json");
assert.equal(version.headers.get("cache-control"), "no-store");
assert.deepEqual(await version.json(), { buildId, customerUpdate: null });
const identity = await request("/release.json");
assert.equal(identity.headers.get("cache-control"), "no-store");
const release = await identity.json();
assert.deepEqual(release, {
  schema: 1, environment: "cloud-preview", cloudCommit, frontendCommit, buildId,
});

const home = await request("/");
assert.equal(home.headers.get("cache-control"), "no-store");
const html = await home.text();
assert.match(html, /PAIGE/i);
assert.equal(await (await request("/f2/smoke/deep-link")).text(), html);
await request("/privacy");
await request("/sms-terms");
await request("/auth", 403);
await request("/auth.html", 403);
await request("/auth/callback", 403);
await request("/sw.js", 404);
await request("/api/f2-probe", 404);
await request("/api/f2-probe", 405, { method: "POST" });

const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
assert.ok(asset, "Built HTML should reference a local fingerprinted asset.");
assert.match((await request(asset)).headers.get("cache-control") ?? "", /immutable/);
assert.equal((await request("/assets/f2-missing.js", 404)).headers.get("cache-control"), "no-store");
console.log(JSON.stringify(release));
