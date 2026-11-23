import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { pagesPreviewUrl } from "../owner-view/pr-previews.mjs";

const pr = Number(process.env.PAIGE_PREVIEW_PULL_REQUEST);
const frontendCommit = process.env.PAIGE_PREVIEW_HEAD;
const cloudCommit = process.env.GITHUB_SHA;
const repo = "Paige-Agent-AI/Paige-Agent-AI";
const url = pagesPreviewUrl(pr, process.env.PAIGE_PREVIEW_PAGES_PROJECT);
for (const commit of [frontendCommit, cloudCommit]) assert.match(commit ?? "", /^[a-f0-9]{40}$/);

function read(path, init) {
  return fetch(path, { ...init, redirect: "error", signal: AbortSignal.timeout(8000) });
}

async function verifyOpenHead() {
  const response = await read(`https://api.github.com/repos/${repo}/pulls/${pr}`);
  assert.equal(response.status, 200);
  const source = await response.json();
  assert.equal(source.state, "open");
  assert.equal(source.base.ref, "main");
  assert.equal(source.base.repo.full_name, repo);
  assert.equal(source.head.repo.full_name, repo);
  assert.equal(source.head.sha, frontendCommit);
}

async function verifyLive() {
  const [manifest, health, home, auth, deep, authWrite] = await Promise.all([
    read(`${url}/release.json`),
    read(`${url}/healthz`),
    read(url),
    read(`${url}/auth?mode=login`),
    read(`${url}/solo/preview/command-center`),
    read(`${url}/auth`, { method: "POST" }),
  ]);
  try {
    for (const response of [manifest, health, home, auth, deep]) assert.equal(response.status, 200);
    const version = await manifest.json();
    assert.equal(version.frontendCommit, frontendCommit);
    assert.equal(version.cloudCommit, cloudCommit);
    assert.equal((await health.text()).trim(), "ok");
    assert.match(home.headers.get("content-security-policy") ?? "", /connect-src 'self';.*form-action 'none'/);
    assert.match(home.headers.get("x-robots-tag") ?? "", /\bnoindex\b/i);
    const [shell, authPage, deepPage] = await Promise.all([home.text(), auth.text(), deep.text()]);
    assert.match(shell, /^<!doctype html/i);
    assert.match(authPage, /^<!doctype html/i);
    assert.notEqual(authPage, shell, "The preview sign-in route must serve the inert sign-in page.");
    assert.equal(deepPage, shell, "A deep preview route must serve the verified app shell.");
    assert.ok([404, 405].includes(authWrite.status), `Preview auth writes returned HTTP ${authWrite.status}.`);
  } finally {
    await Promise.all([manifest, health, home, auth, deep, authWrite].filter((response) => !response.bodyUsed)
      .map((response) => response.body?.cancel()));
  }
}

if (process.argv[2] === "before") {
  await verifyOpenHead();
} else if (process.argv[2] === "live") {
  for (let attempt = 1; ; attempt++) {
    try {
      await verifyLive();
      break;
    } catch (error) {
      if (attempt === 24) throw error;
      await setTimeout(5000);
    }
  }
  await verifyOpenHead();
  console.log(JSON.stringify({ pr, url, frontendCommit, cloudCommit, provider: "cloudflare-pages", result: "verified" }));
} else {
  throw new Error("Use before or live to verify a Pages preview.");
}
