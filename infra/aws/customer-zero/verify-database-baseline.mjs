import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const files = [
  "baseline_roles.sql",
  "baseline_schema.sql",
  "baseline_public_acl.sql",
  "migration_list.txt",
  "migration_list_after.txt",
  "recorded_versions.txt",
];
const sha256 = /^[a-f0-9]{64}$/;
const sha1 = /^[a-f0-9]{40}$/;
const receipt = /^https:\/\/(?:linear\.app\/paigeagentai\/|github\.com\/Paige-Agent-AI\/)[^\s]+$/;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function readFile(directory, name) {
  const path = join(directory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or invalid baseline file: ${name}`);
  return readFileSync(path);
}

// The manifest digest comes from the independently reviewed receipt, never the bundle.
// This checks artifact integrity. Database restore and regression proof have their own gates.
export function verifyDatabaseBaseline({ directory, approvedManifestSha256, expectedSourceCommit }) {
  if (!sha256.test(approvedManifestSha256) || !sha1.test(expectedSourceCommit)) {
    throw new Error("A reviewed manifest digest and exact deployed source are required");
  }
  const bytes = readFile(directory, "manifest.json");
  if (digest(bytes) !== approvedManifestSha256) throw new Error("Baseline manifest differs from the reviewed artifact");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest?.schema !== "paige.database-baseline.v1" || manifest.sourceCommit !== expectedSourceCommit ||
      !Number.isFinite(Date.parse(manifest.capturedAt)) || !/^17(?:\.\d+)+$/.test(manifest.postgresVersion) ||
      !/^\d+\.\d+\.\d+$/.test(manifest.cliVersion) || !/^sha256:[a-f0-9]{64}$/.test(manifest.postgresImage) ||
      !receipt.test(manifest.captureReceipt) || !receipt.test(manifest.restoreReceipt) ||
      manifest.captureReceipt === manifest.restoreReceipt || Object.keys(manifest.files ?? {}).length !== files.length) {
    throw new Error("Baseline provenance or independent restore receipt is incomplete");
  }
  let versions;
  for (const name of files) {
    const contents = readFile(directory, name);
    if (!Object.hasOwn(manifest.files, name) || digest(contents) !== manifest.files[name]) {
      throw new Error(`Baseline file differs from the reviewed artifact: ${name}`);
    }
    if (name === "recorded_versions.txt") versions = contents.toString("utf8").trim().split(/\r?\n/);
  }
  if (!versions.every((version, index) => /^\d{14}$/.test(version) && (index === 0 || version > versions[index - 1]))) {
    throw new Error("Baseline migration ledger must be nonempty, unique and ordered");
  }
  return { state: "artifact_verified", sourceCommit: manifest.sourceCommit, recordedMigrationCount: versions.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , directory, approvedManifestSha256, expectedSourceCommit] = process.argv;
  try {
    console.log(JSON.stringify(verifyDatabaseBaseline({ directory, approvedManifestSha256, expectedSourceCommit })));
  } catch (error) {
    console.error(`Baseline rejected: ${error instanceof SyntaxError ? "invalid manifest JSON" : error.message}`);
    process.exitCode = 1;
  }
}
