import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readPreviewStatus } from "./status.mjs";

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
  deployment_uuid: row.id, finished_at: row.finishedAt, created_at: row.finishedAt,
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
