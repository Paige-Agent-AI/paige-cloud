import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrPreviewReader } from "./pr-previews.mjs";

const repo = "Paige-Agent-AI/Paige-Agent-AI";
const head = "1".repeat(40);
const previous = "2".repeat(40);
const builder = "3".repeat(40);
const token = "fixture-private-actions-only";

const pr = (number, commit = head, headRepo = repo) => ({
  number, title: `Test PR ${number}`, state: "open", base: { ref: "main" },
  head: { repo: { full_name: headRepo }, ref: `preview-${number}`, sha: commit },
});
const run = (number, id, status, conclusion, commit = head) => ({
  display_title: `Preview PR #${number} @ ${commit}`, id, status, conclusion,
  head_sha: builder, event: "workflow_dispatch", head_branch: "main",
});

test("shows the current PR's build and only links an exact live preview", async () => {
  let fetches = 0;
  let now = 0;
  const pulls = [pr(1), pr(2), pr(3), pr(4), pr(5, head, "untrusted/fork"), pr(6)];
  const runs = [run(1, 101, "completed", "success"), run(2, 102, "in_progress"),
    run(3, 103, "completed", "failure"), run(4, 104, "completed", "success", previous),
    run(5, 105, "completed", "success"), run(6, 106, "completed", "success")];
  const read = createPrPreviewReader(token, async (url, options) => {
    fetches++;
    assert.equal(options.redirect, "error");
    if (url.includes("/actions/workflows/")) {
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      return Response.json({ workflow_runs: runs });
    }
    assert.equal(options.headers.Authorization, undefined);
    if (url.includes("/pulls?")) return Response.json(pulls);
    if (url === "https://pr-1.preview.179.66.154.248.sslip.io/release.json") {
      return Response.json({ frontendCommit: head, cloudCommit: builder });
    }
    if (url === "https://pr-6.preview.179.66.154.248.sslip.io/release.json") {
      return Response.json({ frontendCommit: head, cloudCommit: previous });
    }
    throw new Error(`Unexpected request ${url}`);
  }, () => now);
  const result = await read();
  assert.deepEqual(result.rows.map((entry) => entry.build), ["built", "building", "failed", "not-built", "external", "built"]);
  assert.equal(result.rows[0].previewUrl, "https://pr-1.preview.179.66.154.248.sslip.io");
  assert.ok(result.rows.slice(1).every((entry) => entry.previewUrl === undefined));
  assert.equal(fetches, 4);
  assert.equal(await read(), result);
  assert.equal(fetches, 4);
  now = 60001;
  assert.notEqual(await read(), result);
});

test("keeps the verified pilot visible if private GitHub build status is unconfigured", async () => {
  const pilotHead = "56f13b60265b29323d492d001f0242c302801828";
  const pilotBuilder = "ce4e81eb2ba29075ad93ca47231324fd0d756ce6";
  const read = createPrPreviewReader(undefined, async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    if (url.includes("/pulls?")) return Response.json([pr(3365, pilotHead), pr(8)]);
    if (url === "https://pr-3365-56f13b6.179.66.154.248.sslip.io/release.json") {
      return Response.json({ frontendCommit: pilotHead, cloudCommit: pilotBuilder });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const result = await read();
  assert.equal(result.builds, "unconfigured");
  assert.equal(result.rows[0].build, "built");
  assert.equal(result.rows[0].run, "44953319787");
  assert.equal(result.rows[0].previewUrl, "https://pr-3365-56f13b6.179.66.154.248.sslip.io");
  assert.equal(result.rows[1].build, "unknown");
});
