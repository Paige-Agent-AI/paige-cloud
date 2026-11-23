import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { createProductionHistory } from "./production-history.mjs";
import { readProductionStatus } from "./status.mjs";

const archiveName = "paige-production-receipt.json";
const repository = { id: 1207965608, full_name: "Paige-Agent-AI/Paige-Agent-AI" };
const fixture = JSON.parse(readFileSync(new URL("./production-receipts.json", import.meta.url)))[0];
const deployment = "a0".repeat(12);
const newCommit = "b".repeat(40);
const row = { ...fixture, workflow: { runId: "1000", attempt: "2" }, finishedAt: "2026-11-25T19:00:08Z",
  candidate: { ...fixture.candidate, commit: newCommit }, deployment };
const run = { id: 1000, run_attempt: 2, head_sha: newCommit, head_branch: "main", repository, head_repository: repository,
  event: "workflow_run", status: "completed", conclusion: "success", path: ".github/workflows/paige-coolify.yml" };
const signedStorage = "https://teststorage.blob.core.windows.net/verified/receipt.zip?signature=storage-only";
const actionsToken = "fixture-verified-actions-read";
const coolifyToken = "fixture-production-app-read";

function zip(entry, content, method = 8) {
  const name = Buffer.from(entry);
  const plain = Buffer.from(JSON.stringify(content));
  const compressed = method === 8 ? deflateRawSync(plain) : plain;
  const local = Buffer.alloc(30);
  const flags = 0x808;
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(name.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50);
  descriptor.writeUInt32LE(crc32(plain), 4);
  descriptor.writeUInt32LE(compressed.length, 8);
  descriptor.writeUInt32LE(plain.length, 12);
  const file = Buffer.concat([local, name, compressed, descriptor]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(plain), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(plain.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(file.length, 16);
  return Buffer.concat([file, central, name, end]);
}

function sources({ evidence = row, workflowRun = run, redirect = signedStorage, checksum, entry = archiveName, filename } = {}) {
  const calls = [];
  const archive = zip(entry, evidence);
  const fetchFrom = async (value, options) => {
    const url = new URL(value);
    const authorization = options.headers?.Authorization;
    calls.push({ hostname: url.hostname, path: url.pathname, authorization });
    if (url.hostname === "api.github.com") {
      assert.equal(authorization, `Bearer ${actionsToken}`);
      if (url.pathname.endsWith("/workflows/paige-coolify.yml/runs")) {
        return Response.json({ workflow_runs: url.searchParams.get("event") === "workflow_run" ? [workflowRun] : [] });
      }
      if (url.pathname.endsWith("/runs/1000/artifacts")) {
        const requested = url.searchParams.get("name");
        assert.equal(requested, "paige-production-receipt-1000-2");
        return Response.json({ artifacts: [{ id: 151, name: filename ?? requested, expired: false,
          size_in_bytes: archive.length, digest: checksum ?? `sha256:${createHash("sha256").update(archive).digest("hex")}`,
          workflow_run: { id: 1000, repository_id: repository.id, head_repository_id: repository.id,
            head_sha: newCommit, head_branch: "main" } }] });
      }
      if (url.pathname.endsWith("/artifacts/151/zip")) {
        assert.equal(options.redirect, "manual");
        return new Response(null, { status: 302, headers: { location: redirect } });
      }
    }
    if (url.href === signedStorage) {
      assert.equal(authorization, undefined);
      assert.equal(options.redirect, "error");
      return new Response(archive);
    }
    assert.fail(`Unexpected request to ${url.hostname}`);
  };
  return { calls, fetchFrom };
}

async function synced(history) {
  for (let i = 0; i < 100; i++) {
    const snapshot = await history.read();
    if (snapshot.receiptSource !== "checking") return snapshot;
    await setImmediate();
  }
  assert.fail("Receipt refresh did not settle");
}

test("imports, retains, and reopens a verified production receipt from exact trusted workflow evidence", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "paige-production-history-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const filename = join(folder, "receipts.sqlite");
  const remote = sources();
  const first = createProductionHistory({ actionsToken, filename, fetchFrom: remote.fetchFrom });
  const initial = await synced(first);
  assert.equal(initial.receiptSource, "available");
  assert.equal(initial.receipts[0].deployment, deployment);
  assert.equal(initial.receipts[0].commit, newCommit);
  assert.equal(initial.receipts[0].artifactId, "151");
  assert.equal(initial.receipts[0].rollback.deployment, fixture.previous.deployment);
  assert.equal(initial.receipts.length, 4);
  assert.equal(remote.calls.filter((call) => call.hostname.endsWith(".windows.net")).length, 1);
  first.close();
  const unavailable = createProductionHistory({ actionsToken, filename, fetchFrom: async () => new Response(null, { status: 401 }) });
  try {
    const stored = await synced(unavailable);
    assert.equal(stored.receiptSource, "unavailable");
    assert.equal(stored.receipts[0].deployment, deployment);
  } finally { unavailable.close(); }
});

test("rejects wrong workflow identity, source, attempt, artifact name, checksum, archive entry, and redirect host", async () => {
  for (const changes of [
    { workflowRun: { ...run, event: "push" } },
    { workflowRun: { ...run, head_repository: { ...repository, id: 99 } } },
    { evidence: { ...row, workflow: { ...row.workflow, attempt: "1" } } },
    { evidence: { ...row, candidate: { ...row.candidate, commit: fixture.candidate.commit } } },
    { evidence: { ...row, providerStatus: "in_progress" } },
    { filename: "paige-production-receipt-1000-1" },
    { checksum: `sha256:${"a".repeat(64)}` },
    { entry: "../paige-production-receipt.json" },
    { redirect: "https://bypass.example/receipt.zip" },
    { redirect: "http://teststorage.blob.core.windows.net/archive.zip" },
  ]) {
    const remote = sources(changes);
    const h = createProductionHistory({ actionsToken, fetchFrom: remote.fetchFrom });
    try {
      const result = await synced(h);
      assert.equal(result.receipts.length, 3);
      assert.ok(!remote.calls.some((call) => call.hostname === "bypass.example"));
    } finally { h.close(); }
  }
});

test("paginates only the production app and retains a stale last read during outage", async () => {
  let now = 1;
  let unavailable = false;
  let requests = 0;
  const providerRows = Array.from({ length: 27 }, (_, index) => ({
    deployment_uuid: `deployment${index.toString().padStart(12, "0")}`, status: index ? "finished" : "in_progress",
    created_at: "2026-11-25T19:00:00Z", finished_at: index ? "2026-11-25T19:00:08Z" : null,
    privateField: "not for the dashboard",
  }));
  const history = createProductionHistory({ coolifyToken, clock: () => now, fetchFrom: async (value, options) => {
    const url = new URL(value);
    requests++;
    assert.equal(url.origin, "https://app.coolify.io");
    assert.equal(url.pathname, "/api/v1/deployments/applications/qucl8euvl1vjcg1z3nryqadb");
    assert.equal(options.headers.Authorization, `Bearer ${coolifyToken}`);
    const skip = Number(url.searchParams.get("skip"));
    const take = Number(url.searchParams.get("take"));
    return unavailable ? new Response(null, { status: 503 }) : Response.json({ deployments: providerRows.slice(skip, skip + take) });
  } });
  const result = await history.read();
  assert.equal(result.providerSource, "available");
  assert.equal(result.deployments.length, 27);
  assert.equal(result.deployments[0].status, "in_progress");
  assert.equal(result.deployments[1].elapsedSeconds, 8);
  assert.equal(result.receiptSource, "unconfigured");
  assert.doesNotMatch(JSON.stringify(result), /privateField|not for the dashboard/);
  assert.equal(requests, 3);
  await history.read();
  assert.equal(requests, 3);
  now += 45_001;
  unavailable = true;
  const stale = await history.read();
  assert.equal(stale.providerSource, "stale");
  assert.equal(stale.deployments.length, 27);
  history.close();
});

test("current releases require matching domains and current provider rollout when available", async () => {
  const remote = sources();
  const history = createProductionHistory({ actionsToken, fetchFrom: remote.fetchFrom });
  const snapshot = await synced(history);
  const readDomain = async (value) => new URL(value).pathname === "/healthz" ? new Response("ok")
    : Response.json({ frontendCommit: newCommit, cloudCommit: newCommit });
  const current = await readProductionStatus(readDomain, async () => ({ ...snapshot, providerSource: "available",
    deployments: [{ id: deployment, status: "finished", at: row.finishedAt },
      { id: "c0".repeat(12), status: "in_progress", at: "2026-11-25T20:00:00Z" }] }));
  assert.equal(current.receiptDeployment, deployment);
  const newerRollout = await readProductionStatus(readDomain, async () => ({ ...snapshot, providerSource: "available",
    deployments: [{ id: "c0".repeat(12), status: "finished", at: "2026-11-25T20:00:00Z" }] }));
  assert.equal(newerRollout.receiptCommit, null);
  assert.equal(newerRollout.frontendCommit, newCommit);
  assert.equal(newerRollout.receipts[0].deployment, deployment);
  const stale = await readProductionStatus(readDomain, async () => ({ ...snapshot, providerSource: "stale",
    deployments: [{ id: deployment, status: "finished", at: row.finishedAt }] }));
  assert.equal(stale.receiptDeployment, null);
  assert.equal(stale.receipts[0].deployment, deployment);
  history.close();
});
