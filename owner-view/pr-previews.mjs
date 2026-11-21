const github = "https://api.github.com/repos/Paige-Agent-AI/Paige-Agent-AI";
const builds = "https://api.github.com/repos/Paige-Agent-AI/paige-cloud-preview/actions/workflows/cloud-pr-preview.yml/runs";
const canonical = "Paige-Agent-AI/Paige-Agent-AI";
const sha = /^[a-f0-9]{40}$/;
const statuses = { queued: "queued", requested: "queued", waiting: "queued", pending: "queued", in_progress: "building" };
const pilot = {
  number: 3365, head: "56f13b60265b29323d492d001f0242c302801828",
  cloud: "ce4e81eb2ba29075ad93ca47231324fd0d756ce6", run: "44953319787",
  url: "https://pr-3365-56f13b6.179.66.154.248.sslip.io", state: "built",
};

function timestamp(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

async function readJson(url, fetchFrom, headers, signal) {
  try {
    const result = await fetchFrom(url, { headers, redirect: "error", signal });
    return result.ok ? await result.json() : undefined;
  } catch {
    return undefined;
  }
}

function pullRows(pulls) {
  const byNumber = new Map();
  for (const pr of pulls) {
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.number > 2147483647 ||
        pr.state !== "open" || pr.base?.ref !== "main" || !sha.test(pr.head?.sha ?? "") ||
        typeof pr.title !== "string" || typeof pr.head.ref !== "string") continue;
    byNumber.set(pr.number, {
      number: pr.number, title: pr.title.slice(0, 240), branch: pr.head.ref.slice(0, 200),
      commit: pr.head.sha, eligible: pr.head.repo?.full_name === canonical, updatedAt: timestamp(pr.updated_at),
    });
  }
  return [...byNumber.values()];
}

function buildRecords(runs) {
  const newest = new Map();
  for (const run of runs) {
    const intent = /^Preview PR #([1-9]\d{0,9}) @ ([a-f0-9]{40})$/.exec(run?.display_title ?? "");
    if (!intent || run.event !== "workflow_dispatch" || run.head_branch !== "main" ||
        !sha.test(run.head_sha ?? "") || !Number.isSafeInteger(run.id) || run.id < 1) continue;
    const state = run.status === "completed"
      ? ({ success: "built", failure: "failed", timed_out: "failed", cancelled: "cancelled", action_required: "failed" })[run.conclusion]
      : statuses[run.status];
    if (!state) continue;
    const key = `${intent[1]}/${intent[2]}`;
    if (!newest.has(key) || Number(newest.get(key).run) < run.id) {
      newest.set(key, { state, cloud: run.head_sha, run: String(run.id), createdAt: timestamp(run.created_at) });
    }
  }
  return newest;
}

export function createPrPreviewReader(actionsToken, fetchFrom = fetch, clock = Date.now) {
  // This credential goes only to the private Cloud repository's Actions endpoint.
  const canReadBuilds = /^[\x21-\x7e]{16,512}$/.test(actionsToken ?? "");
  const accept = { Accept: "application/vnd.github+json", "User-Agent": "PAIGE-Cloud" };
  let cached;
  let pending;

  async function refresh() {
    const signal = AbortSignal.timeout(5500);
    const [first, source] = await Promise.all([
      readJson(`${github}/pulls?state=open&base=main&per_page=100`, fetchFrom, accept, signal),
      canReadBuilds ? readJson(`${builds}?per_page=100`, fetchFrom,
        { ...accept, Authorization: `Bearer ${actionsToken}` }, signal) : undefined,
    ]);
    if (!Array.isArray(first)) return { state: "unavailable", rows: [] };
    const pulls = first.slice();
    let page = first;
    for (let number = 2; page.length === 100 && number <= 5; number++) {
      page = await readJson(`${github}/pulls?state=open&base=main&per_page=100&page=${number}`, fetchFrom, accept, signal);
      if (!Array.isArray(page)) return { state: "unavailable", rows: [] };
      pulls.push(...page);
    }
    const canResolve = Array.isArray(source?.workflow_runs);
    const records = buildRecords(canResolve ? source.workflow_runs : []);
    const rows = pullRows(pulls);
    const candidates = [];
    for (const row of rows) {
      const firstPilot = row.number === pilot.number && row.commit === pilot.head ? pilot : undefined;
      const latest = records.get(`${row.number}/${row.commit}`) ?? firstPilot;
      row.build = !row.eligible ? "external" : latest?.state ?? (canResolve ? "not-built" : "unknown");
      if (row.eligible) {
        row.run = latest?.run;
        row.buildCreatedAt = latest?.createdAt;
      }
      if (row.build === "built") {
        const url = row.number === pilot.number ? pilot.url : `https://pr-${row.number}.preview.179.66.154.248.sslip.io`;
        candidates.push({ row, url, cloud: latest.cloud });
      }
    }
    // Bound probe concurrency. No credentials or PR-provided URLs go to preview hosts.
    for (let index = 0; index < candidates.length && !signal.aborted; index += 8) {
      await Promise.all(candidates.slice(index, index + 8).map(async ({ row, url, cloud }) => {
        const live = await readJson(`${url}/release.json`, fetchFrom, {}, signal);
        if (live?.frontendCommit === row.commit && live.cloudCommit === cloud) row.previewUrl = url;
      }));
    }
    return { state: "ready", builds: canResolve ? "available" : canReadBuilds ? "unavailable" : "unconfigured",
      partial: page.length === 100, rows, checkedAt: new Date(clock()).toISOString() };
  }

  return async () => {
    if (cached && clock() - cached.at < 60_000) return cached.data;
    pending ??= refresh().then((data) => {
      cached = { at: clock(), data };
      return data;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
