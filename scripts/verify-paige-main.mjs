import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const repository = "Paige-Agent-AI/Paige-Agent-AI";
const api = `https://api.github.com/repos/${repository}`;
// GitHub user ID of the existing organization release maintainer (mrmogulmaker-bot).
const releaseMaintainer = 232259757;

async function github(path) {
  const response = await fetch(`${api}${path}`, {
    headers: { Accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `GitHub ${path} returned HTTP ${response.status}`);
  return response.json();
}

export async function verifyMain(commit, number) {
  assert.match(commit ?? "", /^[a-f0-9]{40}$/);
  assert.match(number ?? "", /^[1-9][0-9]{0,8}$/);
  const [main, pr] = await Promise.all([
    github("/branches/main"), github(`/pulls/${number}`),
  ]);
  assert.equal(main.commit.sha, commit, "Requested release was superseded by canonical main");
  assert.equal(pr.base?.repo?.full_name, repository);
  assert.equal(pr.base.ref, "main");
  assert.ok(pr.merged && pr.merged_at && pr.merge_commit_sha === commit,
    "The exact main commit must be the result of this merged pull request");

  assert.equal(pr.merged_by?.id, releaseMaintainer,
    "The merge must be performed by the designated repository release maintainer");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyMain(process.argv[2], process.argv[3]);
  console.log(`Canonical main and authorized merger verified for #${process.argv[3]}.`);
}
