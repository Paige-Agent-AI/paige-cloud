import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const appRepo = "Paige-Agent-AI/Paige-Agent-AI";
const cloudRepo = "Paige-Agent-AI/paige-cloud-preview";
const commitId = /^[a-f0-9]{40}$/;
const workflowPhases = { requested: 1, in_progress: 2, completed: 3 };
const conclusions = new Set(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "stale"]);
const maxPayloadBytes = 1024 * 1024;
const previewDispatchUrl = `https://api.github.com/repos/${cloudRepo}/actions/workflows/cloud-pr-preview.yml/dispatches`;
const isSha = (value) => typeof value === "string" && value.length === 40 && commitId.test(value);
const number = (value) => Number.isSafeInteger(value) && value > 0;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function pullEvent(payload, receivedAt) {
  const pull = payload.pull_request;
  if (payload.repository.full_name !== appRepo || !["opened", "reopened", "synchronize", "closed"].includes(payload.action) ||
      !number(pull?.number) || pull.base?.ref !== "main" || pull.base.repo?.full_name !== appRepo ||
      pull.head?.repo?.full_name !== appRepo || !isSha(pull.head.sha)) return null;
  const updatedAt = timestamp(pull.updated_at);
  if (updatedAt === null) return null;
  const previousCommit = payload.action === "synchronize" && isSha(payload.before) && payload.after === pull.head.sha
    ? payload.before : undefined;
  return { id: `pull-${pull.number}`, updatedAt, rank: payload.action === "closed" ? 2 : 1,
    closed: payload.action === "closed", receivedAt, commit: pull.head.sha, previousCommit,
    pull: pull.number, phase: "received", kind: "pull" };
}

function workflowEvent(payload, receivedAt) {
  const repo = payload.repository.full_name;
  const run = payload.workflow_run;
  const rank = Object.hasOwn(workflowPhases, payload.action) ? workflowPhases[payload.action] : 0;
  if (!rank || !number(run?.id) || !number(run.run_attempt) || !isSha(run.head_sha)) return null;
  let kind;
  let pull;
  let commit = run.head_sha;
  if (repo === cloudRepo && run.path === ".github/workflows/cloud-pr-preview.yml" && run.event === "workflow_dispatch" && run.head_branch === "main") {
    const preview = typeof run.display_title === "string" && /^Preview PR #([1-9]\d{0,9}) @ ([a-f0-9]{40})$/.exec(run.display_title);
    if (!preview) return null;
    [, pull, commit] = preview;
    pull = Number(pull);
    kind = "preview";
  } else if (repo === appRepo && run.head_repository?.full_name === appRepo) {
    if (run.path === ".github/workflows/ci.yml" && (run.event === "pull_request" || (run.event === "push" && run.head_branch === "main"))) {
      kind = run.event === "push" ? "main-checks" : "pull-checks";
      const matches = Array.isArray(run.pull_requests) ? run.pull_requests.filter((candidate) =>
        candidate?.head?.sha === commit && candidate.base?.ref === "main" && number(candidate.number)) : [];
      if (matches.length === 1) pull = matches[0].number;
    } else if (run.path === ".github/workflows/paige-coolify.yml" && run.head_branch === "main" &&
        ["workflow_run", "workflow_dispatch"].includes(run.event)) {
      kind = "production";
    }
  }
  if (!kind) return null;
  const updatedAt = timestamp(run.updated_at);
  if (updatedAt === null) return null;
  const conclusion = rank === 3 && conclusions.has(run.conclusion) ? run.conclusion : undefined;
  const startedAt = rank >= 2 && conclusion !== "skipped" ? timestamp(run.run_started_at) : null;
  return { id: `${kind}-${run.id}-${run.run_attempt}`, rank, kind, run: run.id, pull, commit, receivedAt,
    updatedAt, queuedAt: timestamp(run.created_at), startedAt, finishedAt: rank === 3 ? updatedAt : null,
    phase: rank === 3 ? "completed" : rank === 2 ? "running" : "queued", conclusion };
}

export function createPreviewDispatch(token, fetchFrom = fetch) {
  if (!token) return undefined;
  if (!/^[\x21-\x7e]{16,512}$/.test(token)) throw new Error("Invalid Cloud preview dispatch credential.");
  return async (pull, commit) => {
    try {
      const response = await fetchFrom(previewDispatchUrl, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main", inputs: { pull_request: String(pull), head_sha: commit } }),
      });
      await response.body?.cancel();
      if (response.status === 204 || response.status === 200) return "accepted";
      return response.status >= 500 ? "unknown" : "rejected";
    } catch { return "unknown"; }
  };
}

export function openGitHubBuilds(filename, secret, clock = Date.now, dispatchPreview) {
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret) || secret.length !== 64) {
    throw new Error("GitHub build webhook secret must be 32 random bytes encoded as hex.");
  }
  const db = new DatabaseSync(filename, { timeout: 1000 });
  db.exec(`CREATE TABLE IF NOT EXISTS github_build_observations (
    id TEXT PRIMARY KEY, rank INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS github_preview_dispatches (
    pull INTEGER NOT NULL, commit_sha TEXT NOT NULL, requested_at INTEGER NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY (pull, commit_sha)
  )`);
  const select = db.prepare("SELECT payload FROM github_build_observations WHERE id = ?");
  const recent = db.prepare("SELECT payload FROM github_build_observations ORDER BY updated_at DESC LIMIT 100");
  const store = db.prepare(`INSERT INTO github_build_observations (id, rank, updated_at, payload) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET rank=excluded.rank, updated_at=excluded.updated_at, payload=excluded.payload
    WHERE excluded.updated_at > github_build_observations.updated_at
       OR (excluded.updated_at = github_build_observations.updated_at AND excluded.rank >= github_build_observations.rank)`);
  const prune = db.prepare("DELETE FROM github_build_observations WHERE id NOT IN (SELECT id FROM github_build_observations ORDER BY updated_at DESC LIMIT 1000)");
  const enqueue = db.prepare("INSERT OR IGNORE INTO github_preview_dispatches VALUES (?, ?, ?, 'pending')");
  const nextDispatch = db.prepare("SELECT * FROM github_preview_dispatches WHERE state='pending' ORDER BY requested_at LIMIT 1");
  const updateDispatch = db.prepare("UPDATE github_preview_dispatches SET state=? WHERE pull=? AND commit_sha=? AND state=?");
  const dispatchRows = db.prepare("SELECT * FROM github_preview_dispatches ORDER BY requested_at DESC LIMIT 100");
  const listeners = new Set();
  let mainGeneration = 0;
  let dispatching = false;
  let closed = false;
  const snapshot = () => {
    const rows = recent.all().map(({ payload }) => JSON.parse(payload)).filter((row) => !row.closed && row.kind !== "push");
    const states = new Map(dispatchRows.all().map((row) => [`${row.pull}/${row.commit_sha}`, row.state]));
    return rows.map((row) => row.kind === "pull" ? { ...row, dispatch: states.get(`${row.pull}/${row.commit}`) } : row);
  };

  function notify() {
    if (listeners.size) {
      const rows = snapshot();
      for (const listener of listeners) listener(rows);
    }
  }

  async function drainDispatches() {
    if (!dispatchPreview || closed || dispatching) return;
    dispatching = true;
    try {
      while (!closed) {
        const next = nextDispatch.get();
        if (!next) break;
        const pull = JSON.parse(select.get(`pull-${next.pull}`)?.payload ?? "null");
        if (!pull || pull.closed || pull.commit !== next.commit_sha) {
          updateDispatch.run("superseded", next.pull, next.commit_sha, "pending");
          continue;
        }
        if (updateDispatch.run("sending", next.pull, next.commit_sha, "pending").changes === 0) continue;
        const result = await dispatchPreview(next.pull, next.commit_sha).catch(() => "unknown");
        if (closed) break;
        updateDispatch.run(result, next.pull, next.commit_sha, "sending");
        notify();
      }
    } catch {
      console.error("Cloud could not process the preview dispatch queue.");
    } finally { dispatching = false; }
  }

  if (dispatchPreview) {
    // A previous worker may have received a successful response before it stopped.
    db.exec("UPDATE github_preview_dispatches SET state='unknown' WHERE state='sending'");
    setImmediate(() => void drainDispatches());
  }

  function record(row) {
    const previous = select.get(row.id);
    if (previous) {
      if (row.kind === "push") return false;
      const current = JSON.parse(previous.payload);
      // Workflow lifecycle must not move backwards when a delivery arrives late.
      if (row.kind !== "pull" && row.rank < current.rank) return false;
      const advancesSameSecond = row.kind === "pull" && row.previousCommit === current.commit && row.commit !== current.commit;
      if (row.updatedAt === current.updatedAt && row.rank === current.rank && !advancesSameSecond) return false;
      if (current.commit === row.commit) row.receivedAt = current.receivedAt;
    }
    if (store.run(row.id, row.rank, row.updatedAt, JSON.stringify(row)).changes === 0) return false;
    prune.run();
    return true;
  }

  function persist(row) {
    let changed;
    let queued = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      changed = record(row);
      if (dispatchPreview && row.kind === "pull" && !row.closed) {
        const active = JSON.parse(select.get(row.id)?.payload ?? "null");
        queued = Boolean(active && !active.closed && active.commit === row.commit &&
          enqueue.run(row.pull, row.commit, row.receivedAt).changes);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (changed && row.kind === "push") mainGeneration++;
    if (changed || queued) notify();
    if (queued) setImmediate(() => void drainDispatches());
  }

  async function receive(request) {
    const signature = request.headers["x-hub-signature-256"];
    if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature) || signature.length !== 71) return 401;
    const chunks = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxPayloadBytes) {
        request.resume();
        return 413;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks, size);
    const digest = createHmac("sha256", secret).update(body).digest();
    if (!timingSafeEqual(digest, Buffer.from(signature.slice(7), "hex"))) return 401;
    let payload;
    try { payload = JSON.parse(body.toString("utf8")); } catch { return 400; }
    if (![appRepo, cloudRepo].includes(payload?.repository?.full_name)) return 204;
    const kind = request.headers["x-github-event"];
    if (kind === "push" && payload.repository.full_name === appRepo && payload.ref === "refs/heads/main" && isSha(payload.after)) {
      const delivery = request.headers["x-github-delivery"];
      if (typeof delivery !== "string" || !/^[a-f0-9-]{36}$/.test(delivery) || delivery.length !== 36) return 400;
      const receivedAt = clock();
      persist({ id: "push-" + delivery, rank: 1, kind: "push", commit: payload.after, receivedAt, updatedAt: receivedAt });
      return 204;
    }
    const row = kind === "pull_request" ? pullEvent(payload, clock())
      : kind === "workflow_run" ? workflowEvent(payload, clock()) : null;
    if (row) persist(row);
    return 204;
  }

  return { receive, snapshot, mainVersion: () => mainGeneration, subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, close() { closed = true; db.close(); } };
}
