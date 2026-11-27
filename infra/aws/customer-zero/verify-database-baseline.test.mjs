import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyDatabaseBaseline } from "./verify-database-baseline.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceCommit = "a".repeat(40);
const fixture = {
  "baseline_roles.sql": "-- synthetic file integrity fixture\n",
  "baseline_schema.sql": "-- synthetic schema fixture\n",
  "baseline_public_acl.sql": "-- synthetic ACL fixture\n",
  "migration_list.txt": "synthetic before\n",
  "migration_list_after.txt": "synthetic after\n",
  "recorded_versions.txt": "20260101000000\n20260101000001\n",
};

function fixtureBundle(t, overrides = {}, manifestChanges = {}) {
  const directory = mkdtempSync(join(tmpdir(), "paige-baseline-verifier-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const contents = { ...fixture, ...overrides };
  for (const [name, value] of Object.entries(contents)) writeFileSync(join(directory, name), value);
  const manifest = JSON.stringify({
    schema: "paige.database-baseline.v1", sourceCommit, capturedAt: "2026-11-27T17:20:00Z",
    postgresVersion: "17.6", cliVersion: "2.109.1", postgresImage: "sha256:" + "b".repeat(64),
    captureReceipt: "https://linear.app/paigeagentai/issue/ANT-178#comment-fixture-capture",
    restoreReceipt: "https://linear.app/paigeagentai/issue/ANT-178#comment-fixture-restore",
    files: Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, digest(value)])),
    ...manifestChanges,
  });
  writeFileSync(join(directory, "manifest.json"), manifest);
  return { directory, approvedManifestSha256: digest(manifest), expectedSourceCommit: sourceCommit };
}

test("accepts exact pinned artifact bytes and returns only their provenance", t => {
  assert.deepEqual(verifyDatabaseBaseline(fixtureBundle(t)),
    { state: "artifact_verified", sourceCommit, recordedMigrationCount: 2 });
});

test("fails closed for an unapproved manifest, a wrong source or modified ACL", t => {
  const bundle = fixtureBundle(t);
  assert.throws(() => verifyDatabaseBaseline({ ...bundle, approvedManifestSha256: "c".repeat(64) }), /reviewed artifact/);
  assert.throws(() => verifyDatabaseBaseline({ ...bundle, expectedSourceCommit: "d".repeat(40) }), /provenance/);
  writeFileSync(join(bundle.directory, "baseline_public_acl.sql"), "-- replaced\n");
  assert.throws(() => verifyDatabaseBaseline(bundle), /differs.*baseline_public_acl.sql/);
});

test("requires the distinct restore receipt, all dumps and a strictly ordered exact ledger", t => {
  assert.throws(() => verifyDatabaseBaseline(fixtureBundle(t, {}, { restoreReceipt: undefined })), /restore receipt/);
  assert.throws(() => verifyDatabaseBaseline(fixtureBundle(t, { "baseline_roles.sql": "" })), /baseline_roles.sql/);
  assert.throws(() => verifyDatabaseBaseline(fixtureBundle(t, {
    "recorded_versions.txt": "20260101000001\n20260101000001\n",
  })), /unique and ordered/);
});
