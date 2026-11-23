import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrPreviewReader, dedicatedPreviewIp, previewUrlFor, sharedPreviewIp } from "./pr-previews.mjs";

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
  created_at: "2026-11-21T21:00:00Z",
});

test("shows the current PR's build and only links an exact live preview", async () => {
  let fetches = 0;
  let now = 0;
  const pulls = [pr(1), pr(2), pr(3), pr(4), pr(5, head, "untrusted/fork"), pr(6), pr(7)];
  pulls[0].updated_at = "2026-11-21T22:00:00Z";
  const runs = [run(1, 101, "completed", "success"), run(2, 102, "in_progress"),
    run(3, 103, "completed", "failure"), run(4, 104, "completed", "success", previous),
    run(5, 105, "completed", "success"), run(6, 106, "completed", "success"), run(7, 107, "completed", "success")];
  const read = createPrPreviewReader(token, async (url, options) => {
    fetches++;
    assert.equal(options.redirect, "error");
    if (url.includes("/actions/workflows/")) {
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      return Response.json({ workflow_runs: runs });
    }
    assert.equal(options.headers?.Authorization, undefined);
    if (url.includes("/pulls?")) return Response.json(pulls);
    if (url === "https://pr-1.preview.179.66.154.248.sslip.io/release.json") {
      return Response.json({ frontendCommit: head, cloudCommit: builder });
    }
    if (url === "https://pr-6.preview.179.66.154.248.sslip.io/release.json") {
      return Response.json({ frontendCommit: head, cloudCommit: previous });
    }
    if (url === "https://pr-7.preview.179.66.154.248.sslip.io/release.json") {
      return Response.json({ frontendCommit: head, cloudCommit: builder });
    }
    if (url.endsWith("pr-1.preview.179.66.154.248.sslip.io/healthz")) return new Response("ok");
    if (url.endsWith("pr-7.preview.179.66.154.248.sslip.io/healthz")) return new Response("starting", { status: 503 });
    throw new Error(`Unexpected request ${url}`);
  }, () => now);
  const result = await read();
  assert.deepEqual(result.rows.map((entry) => entry.build), ["built", "building", "failed", "not-built", "external", "built", "built"]);
  assert.equal(result.rows[0].previewUrl, "https://pr-1.preview.179.66.154.248.sslip.io");
  assert.equal(result.rows[0].buildCreatedAt, "2026-11-21T21:00:00.000Z");
  assert.equal(result.rows[0].updatedAt, "2026-11-21T22:00:00.000Z");
  assert.equal(result.rows[3].buildCreatedAt, undefined);
  assert.equal(result.rows[4].run, undefined);
  assert.ok(result.rows.slice(1).every((entry) => entry.previewUrl === undefined));
  assert.equal(fetches, 7);
  assert.equal(await read(), result);
  assert.equal(fetches, 7);
  now = 60001;
  assert.notEqual(await read(), result);
});

test("keeps the verified pilot visible if private GitHub build status is unconfigured", async () => {
  const pilotHead = "56f13b60265b29323d492d001f0242c302801828";
  const pilotBuilder = "ce4e81eb2ba29075ad93ca47231324fd0d756ce6";
  const read = createPrPreviewReader(undefined, async (url, options) => {
    assert.equal(options.headers?.Authorization, undefined);
    if (url.includes("/pulls?")) return Response.json([pr(3365, pilotHead), pr(8)]);
    if (url === "https://pr-3365-56f13b6.179.66.154.248.sslip.io/release.json") {
      return Response.json({ frontendCommit: pilotHead, cloudCommit: pilotBuilder });
    }
    if (url === "https://pr-3365-56f13b6.179.66.154.248.sslip.io/healthz") return new Response("ok");
    throw new Error(`Unexpected request ${url}`);
  });
  const result = await read();
  assert.equal(result.builds, "unconfigured");
  assert.equal(result.rows[0].build, "built");
  assert.equal(result.rows[0].run, "44953319787");
  assert.equal(result.rows[0].previewUrl, "https://pr-3365-56f13b6.179.66.154.248.sslip.io");
  assert.equal(result.rows[1].build, "unknown");
});

test("looks up the configured dedicated host and preserves a verified historical address", async () => {
  const dedicatedIp = "93.184.216.34";
  const current = previewUrlFor(3401, false, dedicatedIp);
  const historical = previewUrlFor(3398);
  const read = createPrPreviewReader(token, async (value, options) => {
    const url = new URL(value);
    if (url.pathname.includes("/actions/")) {
      return Response.json({ workflow_runs: [run(3401, 111, "completed", "success"), run(3398, 110, "completed", "success")] });
    }
    assert.equal(options.headers?.Authorization, undefined);
    if (url.pathname.endsWith("/pulls")) return Response.json([pr(3401), pr(3398)]);
    if (![current, historical].includes(url.origin)) return new Response(null, { status: 404 });
    if (url.pathname === "/healthz") return new Response("ok");
    return Response.json({ frontendCommit: head, cloudCommit: builder });
  }, Date.now, dedicatedIp);
  const result = await read();
  assert.equal(result.publicIp, dedicatedIp);
  assert.deepEqual(result.rows.map((row) => row.previewUrl), [current, historical]);
});

test("dedicated preview addresses reject the shared machine, private IPs and non-host inputs", () => {
  for (const ip of [undefined, "", sharedPreviewIp, "127.0.0.1", "10.0.0.1", "172.16.5.1",
    "192.168.1.8", "169.254.169.254", "100.64.0.1", "224.0.0.1", "203.0.113.5", "192.88.99.2",
    "https://93.184.216.34", "93.184.216.34:443", "::1"]) {
    assert.throws(() => dedicatedPreviewIp(ip), /preview server/);
  }
  assert.equal(dedicatedPreviewIp("93.184.216.34"), "93.184.216.34");
});
