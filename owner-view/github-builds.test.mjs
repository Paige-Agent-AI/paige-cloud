import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createPreviewDispatch, openGitHubBuilds } from "./github-builds.mjs";

const secret = "a".repeat(64);
const repo = { full_name: "Paige-Agent-AI/Paige-Agent-AI" };
const cloud = { full_name: "Paige-Agent-AI/paige-cloud-preview" };
const head = "a".repeat(40);
const began = "2026-11-22T15:01:00Z";
const finished = "2026-11-22T15:02:18Z";

function request(event, payload, valid = true) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", valid ? secret : "b".repeat(64)).update(body).digest("hex");
  const stream = Readable.from([body]);
  stream.headers = {
    "x-hub-signature-256": "sha256=" + signature, "x-github-event": event,
    "x-github-delivery": "0b989ba4-242f-11e5-81e1-c7b6966d2516",
  };
  return stream;
}

test("records a pull and exact workflow attempts, preserving timing across retries and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paige-builds-"));
  const file = join(dir, "builds.sqlite");
  let clock = Date.parse("2026-11-22T15:00:00Z");
  let builds = openGitHubBuilds(file, secret, () => clock);
  try {
    const pull = { number: 38, base: { ref: "main", repo }, head: { sha: head, repo }, updated_at: new Date(clock).toISOString() };
    const opened = { action: "opened", repository: repo, pull_request: pull };
    assert.equal(await builds.receive(request("pull_request", opened, false)), 401);
    assert.deepEqual(builds.snapshot(), []);
    assert.equal(await builds.receive(request("pull_request", { ...opened, pull_request: { ...pull, head: { sha: head, repo: cloud } } })), 204);
    assert.deepEqual(builds.snapshot(), []);
    let updates = 0;
    const unsub = builds.subscribe(() => updates++);
    assert.equal(await builds.receive(request("pull_request", opened)), 204);
    assert.equal(await builds.receive(request("pull_request", opened)), 204);
    assert.equal(updates, 1);
    const received = builds.snapshot()[0];
    assert.equal(received.receivedAt, clock);
    assert.equal(received.pull, 38);

    const run = { id: 100, run_attempt: 1, head_sha: "b".repeat(40), head_branch: "main",
      path: ".github/workflows/cloud-pr-preview.yml", event: "workflow_dispatch", display_title: "Preview PR #38 @ " + head,
      created_at: pull.updated_at, run_started_at: began };
    clock = Date.parse(began);
    const started = { action: "in_progress", repository: cloud, workflow_run: { ...run, updated_at: began } };
    await builds.receive(request("workflow_run", started));
    assert.equal(builds.snapshot()[0].phase, "running");
    clock = Date.parse(finished);
    const completed = { ...started, action: "completed", workflow_run: { ...run, updated_at: finished, conclusion: "success" } };
    await builds.receive(request("workflow_run", completed));
    await builds.receive(request("workflow_run", started));
    const preview = builds.snapshot()[0];
    assert.equal(preview.phase, "completed");
    assert.equal(preview.commit, head);
    assert.equal(preview.finishedAt - preview.startedAt, 78_000);
    assert.equal(preview.receivedAt, Date.parse(began));

    const push = { repository: repo, ref: "refs/heads/main", after: head };
    assert.equal(await builds.receive(request("push", push)), 204);
    assert.equal(await builds.receive(request("push", push)), 204);
    assert.equal(builds.mainVersion(), 1);
    assert.equal(updates, 4);
    unsub();
    builds.close();
    builds = openGitHubBuilds(file, secret, () => clock);
    assert.deepEqual(builds.snapshot(), [preview, received]);
  } finally {
    builds.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requests one isolated build per eligible PR head and does not blindly resend uncertain requests", async () => {
  const credential = "fixture-scoped-dispatch-token";
  const calls = [];
  const dispatcher = createPreviewDispatch(credential, async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 503 });
  });
  const builds = openGitHubBuilds(":memory:", secret, Date.now, dispatcher);
  try {
    const payload = { action: "opened", repository: repo, pull_request: {
      number: 38, base: { ref: "main", repo }, head: { sha: head, repo }, updated_at: began,
    } };
    const settled = new Promise((resolve) => builds.subscribe((rows) => {
      if (rows.some((row) => row.dispatch === "unknown")) resolve();
    }));
    await builds.receive(request("pull_request", payload));
    await builds.receive(request("pull_request", payload));
    await settled;
    await builds.receive(request("pull_request", payload));
    assert.equal(calls.length, 1);
    const [{ url, options }] = calls;
    assert.equal(url, "https://api.github.com/repos/Paige-Agent-AI/paige-cloud-preview/actions/workflows/cloud-pr-preview.yml/dispatches");
    assert.equal(options.headers.Authorization, "Bearer " + credential);
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { ref: "main", inputs: { pull_request: "38", head_sha: head } });
    assert.equal(builds.snapshot()[0].dispatch, "unknown");
    assert.doesNotMatch(JSON.stringify(builds.snapshot()), /fixture-scoped-dispatch-token/);
  } finally { builds.close(); }
});

test("accepts the next exact PR head when two pushes share a GitHub timestamp", async () => {
  const builds = openGitHubBuilds(":memory:", secret);
  try {
    const pull = { number: 38, base: { ref: "main", repo }, head: { sha: head, repo }, updated_at: began };
    const changed = "b".repeat(40);
    const initial = { action: "opened", repository: repo, pull_request: pull };
    const next = { action: "synchronize", repository: repo, before: head, after: changed,
      pull_request: { ...pull, head: { sha: changed, repo } } };
    await builds.receive(request("pull_request", initial));
    await builds.receive(request("pull_request", next));
    await builds.receive(request("pull_request", initial));
    assert.equal(builds.snapshot()[0].commit, changed);
  } finally { builds.close(); }
});
