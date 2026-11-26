import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { verifiedProductionReceipts } from "./production-receipts.mjs";
import { createProductionStatusReader, readOwnerStatus, readPreviewStatus, readProductionStatus } from "./status.mjs";

const ledger = JSON.parse(readFileSync(new URL("./release-ledger.json", import.meta.url)));
const f2Id = "izwrky18u9ixdhstnulxpjs5";
const preview = "https://" + f2Id + ".179.66.154.248.sslip.io";
const token = "test-token-available-only-to-provider";
const sampleApp = {
  uuid: f2Id, name: "paige-cloud-f2", status: "running:healthy", fqdn: preview,
  docker_registry_image_name: "ghcr.io/paige-agent-ai/paige-cloud-preview",
  docker_registry_image_tag: ledger.releases.B.imageDigest.replace(":", "-"),
};
const sampleManifest = {
  schema: 1, environment: "cloud-preview", cloudCommit: ledger.releases.B.cloudCommit,
  frontendCommit: ledger.releases.B.frontendCommit,
};
const sampleHistory = ledger.deployments.map((row) => ({
  deployment_uuid: row.id, finished_at: row.finishedAt,
  created_at: new Date(Date.parse(row.finishedAt) - 77_000).toISOString(),
  status: "finished", logs: "private log must never be returned", configuration_snapshot: "private config",
}));

const appPath = "/api/v1/applications/" + f2Id;
const historyPath = "/api/v1/deployments/applications/" + f2Id;
function fakeSource(changes = {}, calls = []) {
  return async (url, opts) => {
    const { origin, pathname } = new URL(url);
    calls.push({ origin, pathname, ...opts });
    assert.equal(opts.method, "GET");
    assert.equal(opts.redirect, "error");
    const payload = ({
      [appPath]: () => Response.json(changes.app ?? sampleApp),
      [historyPath]: () => Response.json({ deployments: changes.history ?? sampleHistory }),
      "/release.json": () => Response.json(changes.manifest ?? sampleManifest),
      "/healthz": () => new Response(changes.health ?? "ok", { status: changes.status ?? 200 }),
    })[pathname];
    if (changes.down?.includes(pathname)) throw new Error("disabled for test");
    return payload();
  };
}

test("verifies B and rollback A from independent sources and excludes provider internals", async () => {
  const reads = [];
  const snapshot = await readPreviewStatus(token, fakeSource({}, reads));
  assert.equal(snapshot.health.state, "healthy");
  assert.equal(snapshot.identity, "verified");
  assert.equal(snapshot.current.imageDigest, ledger.releases.B.imageDigest);
  assert.equal(snapshot.rollback.imageDigest, ledger.releases.A.imageDigest);
  assert.equal(snapshot.history.length, 4);
  assert.equal(snapshot.history[0].elapsedSeconds, 77);
  assert.equal(snapshot.history[0].frontendCommit, sampleManifest.frontendCommit);
  assert.equal(snapshot.history[0].imageDigest, ledger.releases.B.imageDigest);
  assert.equal(snapshot.history[0].source.author, "mrmogulmaker-bot");
  assert.ok(!JSON.stringify(snapshot).includes("private log"));
  assert.ok(!JSON.stringify(snapshot).includes("private config"));
  assert.equal(reads.length, 4);
  for (const read of reads) {
    assert.equal(read.headers.Authorization, read.origin === "https://app.coolify.io" ? "Bearer " + token : undefined);
  }
});

test("withholds digest and rollback when source identity or recent deployment diverges", async () => {
  const changedHistory = {
    ...sampleHistory[0],
    deployment_uuid: "unuseddeploymentid00000",
    created_at: "2026-11-20T19:39:00Z",
    status: "in_progress",
  };
  const inputs = [
    { manifest: { ...sampleManifest, cloudCommit: ledger.releases.A.cloudCommit } },
    { app: { ...sampleApp, docker_registry_image_tag: ledger.releases.A.imageDigest.replace(":", "-") } },
    { history: [...sampleHistory, changedHistory] },
    { history: [sampleHistory[0], { ...changedHistory, created_at: sampleHistory[0].created_at }, ...sampleHistory.slice(1)] },
    { history: [{ ...changedHistory, created_at: sampleHistory[0].created_at }, ...sampleHistory] },
    { history: [{ ...sampleHistory[0], finished_at: "2026-11-20T19:39:00Z" }, ...sampleHistory.slice(1)] },
    { history: [] },
  ];
  for (const input of inputs) {
    const snapshot = await readPreviewStatus(token, fakeSource(input));
    assert.equal(snapshot.identity, "unconfirmed");
    assert.equal(snapshot.current, null);
    assert.equal(snapshot.rollback, null);
  }
});

test("handles partial outages and preview health errors without inventing provider data", async () => {
  const providerDown = await readPreviewStatus(token, fakeSource({ down: [appPath, historyPath] }));
  assert.deepEqual(providerDown.health, { state: "unavailable", httpStatus: 200, provider: "unavailable" });
  assert.equal(providerDown.identity, "unavailable");
  assert.equal(providerDown.history, null);

  const previewDown = await readPreviewStatus(token, fakeSource({ status: 503, health: "failure" }));
  assert.equal(previewDown.health.state, "unhealthy");
  assert.equal(previewDown.health.httpStatus, 503);

  const badRows = await readPreviewStatus(token, fakeSource({ history: [sampleHistory[0], sampleHistory[0]] }));
  assert.equal(badRows.history, null);
  assert.equal(badRows.identity, "unavailable");
});

test("reports provider timings without attributing a different deployment to a known source", async () => {
  const input = { ...sampleHistory[0], finished_at: "2026-11-20T19:39:00Z", commit: sampleManifest.frontendCommit };
  const { history } = await readPreviewStatus(token, fakeSource({ history: [input] }));
  assert.equal(history[0].frontendCommit, null);
  assert.equal(history[0].source, null);
  assert.equal(history[0].imageDigest, null);
  assert.ok(history[0].elapsedSeconds > 0);
});

test("checks the approved production domains without sending the preview credential", async () => {
  const releases = [];
  const previewReads = [];
  const productionHosts = ["paigeagent.ai", "www.paigeagent.ai", "app.paigeagent.ai"];
  const previewSource = fakeSource({}, previewReads);
  const snapshot = await readOwnerStatus(token, async (url, options) => {
    const { hostname, pathname } = new URL(url);
    if (!productionHosts.includes(hostname)) return previewSource(url, options);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).has("authorization"), false);
    releases.push(`${hostname}${pathname}`);
    return pathname === "/healthz" ? new Response("ok") : Response.json({
      ...sampleManifest, unknown: "provider data is never copied into readback",
    });
  });

  assert.equal(releases.length, 6);
  assert.equal(new Set(releases).size, 6);
  assert.equal(snapshot.identity, "verified");
  assert.equal(snapshot.current.name, ledger.releases.B.name);
  assert.equal(snapshot.production.state, "healthy");
  assert.equal(snapshot.production.identity, "matched");
  assert.equal(snapshot.production.frontendCommit, sampleManifest.frontendCommit);
  assert.deepEqual(snapshot.production.domains.map(({ hostname }) => hostname), productionHosts);
  assert.doesNotMatch(JSON.stringify(snapshot.production), /unknown|imageDigest|provider data/);
  assert.equal(previewReads.length, 4);
});

test("shows partial failure and disagreed source without claiming a production revision", async () => {
  const production = await readProductionStatus(async (url) => {
    const { hostname, pathname } = new URL(url);
    if (pathname === "/healthz") {
      if (hostname === "app.paigeagent.ai") throw new Error("No response");
      return hostname === "www.paigeagent.ai" ? new Response("Failure", { status: 503 }) : new Response("ok");
    }
    if (hostname === "app.paigeagent.ai") return new Response("malformed metadata");
    return Response.json({ ...sampleManifest, frontendCommit: hostname === "www.paigeagent.ai" ? "a".repeat(40) : sampleManifest.frontendCommit });
  });

  assert.equal(production.state, "unhealthy");
  assert.equal(production.identity, "mismatch");
  assert.equal(production.frontendCommit, null);
  assert.deepEqual(production.domains.map(({ state, httpStatus }) => [state, httpStatus]), [
    ["healthy", 200], ["unhealthy", 503], ["unavailable", null],
  ]);

  const unavailable = await readProductionStatus(async (url) => new URL(url).pathname === "/healthz"
    ? new Response("ok") : new Response("", { status: 404 }));
  assert.equal(unavailable.state, "healthy");
  assert.equal(unavailable.identity, "unavailable");
  assert.equal(unavailable.frontendCommit, null);
});

test("rejects partial responses and non-string source revisions from production domains", async () => {
  const production = await readProductionStatus(async (url) => {
    const { hostname, pathname } = new URL(url);
    if (pathname === "/healthz") return new Response("ok");
    if (hostname === "paigeagent.ai") return Response.json({ ...sampleManifest, frontendCommit: [sampleManifest.frontendCommit] });
    return Response.json(sampleManifest, { status: hostname === "www.paigeagent.ai" ? 206 : 200 });
  });
  assert.equal(production.identity, "unavailable");
  assert.equal(production.frontendCommit, null);
  assert.deepEqual(production.domains.map(({ frontendCommit }) => frontendCommit), [null, null, sampleManifest.frontendCommit]);
});

test("observes GitHub main independently from the serving revision without a credential", async () => {
  let now = 0;
  let mainReads = 0;
  let domainReads = 0;
  let ref = mainRef("b".repeat(40));
  function mainRef(sha) {
    return { ref: "refs/heads/main", object: { type: "commit", sha } };
  }
  const readProduction = createProductionStatusReader(async (url, options) => {
    assert.equal(new Headers(options.headers).has("authorization"), false);
    const { hostname, pathname } = new URL(url);
    if (hostname === "api.github.com") {
      assert.equal(pathname, "/repos/Paige-Agent-AI/Paige-Agent-AI/git/ref/heads/main");
      assert.equal(options.redirect, "error");
      mainReads++;
      return Response.json(ref);
    }
    domainReads++;
    return pathname === "/healthz" ? new Response("ok") : Response.json(sampleManifest);
  }, () => now);

  const [first, concurrent] = await Promise.all([readProduction(), readProduction()]);
  assert.equal(mainReads, 1);
  assert.equal(domainReads, 12);
  assert.equal(first.mainCommit, "b".repeat(40));
  assert.equal(concurrent.mainCommit, first.mainCommit);
  assert.equal(first.frontendCommit, sampleManifest.frontendCommit);
  assert.equal(first.receiptCommit, null);

  now += 45_000;
  assert.equal((await readProduction()).mainCommit, first.mainCommit);
  assert.equal(mainReads, 1);
  ref = { ref: "refs/heads/preview", object: { type: "commit", sha: "c".repeat(40) } };
  now += 180_000;
  const unavailable = await readProduction();
  assert.equal(unavailable.mainCommit, null);
  assert.equal(unavailable.frontendCommit, sampleManifest.frontendCommit);
  assert.equal(unavailable.state, "healthy");
  await readProduction();
  assert.equal(mainReads, 2);

  ref = mainRef(sampleManifest.frontendCommit);
  now += 60_000;
  const matched = await readProduction();
  assert.equal(matched.mainCommit, matched.frontendCommit);
  assert.equal(mainReads, 3);
});

test("rechecks GitHub main if a push arrives during an in-flight lookup", async () => {
  let generation = 0;
  let mainReads = 0;
  let releaseFirst;
  const firstRead = new Promise((resolve) => { releaseFirst = resolve; });
  const readProduction = createProductionStatusReader(async (url) => {
    const { hostname, pathname } = new URL(url);
    if (hostname !== "api.github.com") {
      return pathname === "/healthz" ? new Response("ok") : Response.json(sampleManifest);
    }
    const sha = generation ? "b".repeat(40) : "a".repeat(40);
    if (++mainReads === 1) await firstRead;
    return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha } });
  }, Date.now, () => generation);
  const beforePush = readProduction();
  generation++;
  const afterPush = readProduction();
  releaseFirst();
  assert.equal((await beforePush).mainCommit, "a".repeat(40));
  assert.equal((await afterPush).mainCommit, "b".repeat(40));
  assert.equal(mainReads, 2);
});
test("shows verified receipt evidence separately from live health and fails closed on invalid evidence", async () => {
  const ledger = JSON.parse(readFileSync(new URL("./production-receipts.json", import.meta.url), "utf8"));
  const [row] = ledger;
  const commit = row.candidate.commit;
  const status = await readProductionStatus(async (url) => {
    const { hostname, pathname } = new URL(url);
    if (pathname === "/healthz") return new Response(hostname === "app.paigeagent.ai" ? "failed" : "ok");
    return Response.json({ frontendCommit: commit, cloudCommit: commit });
  });
  assert.equal(status.state, "unhealthy");
  assert.equal(status.receiptCommit, commit);
  assert.equal(status.receipts[0].image, row.candidate.image);
  assert.equal(status.receipts[0].rollback.image, row.previous.image);
  const history = await readProductionStatus(async (url) => new URL(url).pathname === "/healthz"
    ? new Response("ok") : Response.json(sampleManifest));
  assert.equal(history.receiptCommit, null);
  assert.equal(history.receipts[0].commit, commit);
  const hostingMismatch = await readProductionStatus(async (url) => new URL(url).pathname === "/healthz"
    ? new Response("ok") : Response.json({ frontendCommit: commit, cloudCommit: sampleManifest.cloudCommit }));
  assert.equal(hostingMismatch.frontendCommit, commit);
  assert.equal(hostingMismatch.receiptCommit, null);
  assert.deepEqual(verifiedProductionReceipts([row, row]), []);
  assert.deepEqual(verifiedProductionReceipts([{ ...row, result: "failed" }]), []);
  assert.deepEqual(verifiedProductionReceipts([{ ...row, candidate: { commit, image: "https://unrelated.test/image" } }]), []);
  assert.deepEqual(verifiedProductionReceipts([{ ...row, domains: [row.domains[0], row.domains[0], row.domains[0]] }]), []);
  assert.doesNotMatch(JSON.stringify(verifiedProductionReceipts([{ ...row, privateData: "omit this" }])), /omit this/);
});
// Workload evidence reads are opt-in and scoped to the approved binding fingerprint.
test("bound workload reader uses one fixed GET and withholds foreign responses", async () => {
  const { createBoundApplicationReader } = await import("./status.mjs");
  const id = "a".repeat(24), fingerprint = "b".repeat(64);
  const token = "fixture-read-only-token";
  let responseId = id, calls = 0;
  const reader = createBoundApplicationReader(token, fingerprint, async (url, opts) => {
    calls++;
    assert.equal(url, `https://app.coolify.io/api/v1/applications/${id}`);
    assert.equal(opts.method, "GET");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.headers.Authorization, `Bearer ${token}`);
    return Response.json({ uuid: responseId, status: "running:healthy", secret: "not-returned" });
  });
  const target = { provider: "coolify", resourceId: id, fingerprint };
  assert.equal(reader({ ...target, fingerprint: "c".repeat(64) }), undefined);
  assert.equal(calls, 0);
  const observed = await reader(target)();
  assert.equal(observed.state, "Running · healthy");
  assert.deepEqual(Object.keys(observed).sort(), ["checkedAt", "state"]);
  responseId = "d".repeat(24);
  assert.equal(await reader(target)(), null);
  assert.equal(calls, 2);
});
