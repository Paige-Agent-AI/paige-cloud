import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { preparePagesPreview } from "./prepare-pages-preview.mjs";

const frontend = "1".repeat(40);
const cloud = "2".repeat(40);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "paige-pages-bundle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "index.html"), "<!doctype html><p>Preview</p>");
  writeFileSync(join(directory, "auth.html"), "<!doctype html><p>Preview only</p>");
  writeFileSync(join(directory, "release.json"), JSON.stringify({ frontendCommit: frontend, cloudCommit: cloud }));
  return directory;
}

test("creates Pages headers and health marker for the exact static bundle", (t) => {
  const directory = fixture(t);
  preparePagesPreview(directory, frontend, cloud);
  assert.equal(readFileSync(join(directory, "healthz"), "utf8"), "ok\n");
  assert.match(readFileSync(join(directory, "_headers"), "utf8"), /connect-src 'self';.*form-action 'none'/);
});

test("rejects a branch-supplied Worker or a manifest from another commit", (t) => {
  const directory = fixture(t);
  assert.throws(() => preparePagesPreview(directory, "3".repeat(40), cloud));
  writeFileSync(join(directory, "_worker.js"), "export default {}");
  assert.throws(() => preparePagesPreview(directory, frontend, cloud), /reserved Pages path/);
});
