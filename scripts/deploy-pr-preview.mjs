import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const receiptPath = process.argv[2];
assert.ok(receiptPath, "Usage: node scripts/deploy-pr-preview.mjs <paige-pr-preview.json>");
const token = process.env.COOLIFY_CLOUD_TOKEN;
assert.ok(token, "Use the existing approved Cloud operator credential.");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const repo = "Paige-Agent-AI/Paige-Agent-AI";
const image = "ghcr.io/paige-agent-ai/paige-agent-ai-pr-preview";
const sha = /^[a-f0-9]{40}$/;
const pr = receipt.pullRequest;
assert.ok(Number.isSafeInteger(pr) && pr > 0 && pr <= 2147483647);
assert.equal(receipt.environment, "pull-request-preview");
assert.equal(receipt.verification, "image-smoke-passed");
assert.match(receipt.frontendCommit ?? "", sha);
assert.match(receipt.cloudCommit ?? "", sha);
assert.match(receipt.tag ?? "", new RegExp(`^pr-${pr}-[1-9][0-9]+-[1-9][0-9]*$`));
const digest = /^ghcr\.io\/paige-agent-ai\/paige-agent-ai-pr-preview@sha256:([a-f0-9]{64})$/.exec(receipt.image ?? "")?.[1];
assert.ok(digest, "The preview-only registry digest is required.");
const tag = `sha256-${digest}`;
const domain = pr === 3365 ? "https://pr-3365-56f13b6.179.66.154.248.sslip.io" : `https://pr-${pr}.preview.179.66.154.248.sslip.io`;
const name = `paige-pr-preview-${pr}`;
const project = "mvokcozpkh3u8grmordxzjly";
const environment = "igihntzdp7htuxz6yqxdx3ql";
const destination = "qhj2gr632xrfotx24vphy98v";

async function getJson(url, options) {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${url} returned HTTP ${response.status}.`);
  return response.json();
}

function coolify(path, method = "GET", body) {
  return getJson(`https://app.coolify.io/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
}

async function verifyHead() {
  const source = await getJson(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "PAIGE-Cloud" },
  });
  assert.equal(source.state, "open");
  assert.equal(source.base.ref, "main");
  assert.equal(source.base.repo.full_name, repo);
  assert.equal(source.head.repo.full_name, repo);
  assert.equal(source.head.sha, receipt.frontendCommit, "The PR head changed after the build.");
}
await verifyHead();

const env = await coolify(`/projects/${project}/f2-preview`);
assert.equal(env.uuid, environment);
let matches = env.applications.filter((app) => app.name === name);
assert.ok(matches.length <= 1, "More than one app uses this PR preview address.");
if (!matches.length) {
  const created = await coolify("/applications/dockerimage", "POST", {
    project_uuid: project, environment_uuid: environment, server_uuid: "p2mh5nemklmkmb6rtnuw8swd", destination_uuid: destination,
    name, domains: domain, noindex_domains: [domain], docker_registry_image_name: image, docker_registry_image_tag: tag,
    ports_exposes: "8080", health_check_enabled: true, health_check_path: "/healthz", health_check_port: 8080,
    health_check_return_code: 200, limits_memory: "128m", limits_cpus: "0.25", instant_deploy: false,
    is_force_https_enabled: true, is_preview_deployments_enabled: false,
  });
  matches = [created];
}
const { uuid } = matches[0];
assert.match(uuid ?? "", /^[a-z0-9]{20,32}$/);
const path = `/applications/${uuid}`;
const app = await coolify(path);
assert.equal(app.uuid, uuid);
assert.equal(app.name, name);
assert.equal(app.fqdn, domain);
assert.equal(app.environment_id, env.id);
assert.equal(app.build_pack, "dockerimage");
assert.equal(app.docker_registry_image_name, image);
assert.equal(app.ports_exposes, "8080");
assert.equal(app.health_check_path, "/healthz");
const destinations = await coolify(`${path}/destinations`);
assert.deepEqual(destinations.map((item) => item.uuid), [destination]);
assert.deepEqual(await coolify(`${path}/envs`), [], "A visual preview must have no configured environment variables.");

async function verifiesLive() {
  try {
    const manifest = await getJson(`${domain}/release.json`);
    return manifest.frontendCommit === receipt.frontendCommit && manifest.cloudCommit === receipt.cloudCommit;
  } catch { return false; }
}

if (app.docker_registry_image_tag === tag && app.status === "running:healthy" && await verifiesLive()) {
  console.log(JSON.stringify({ pr, url: domain, frontendCommit: receipt.frontendCommit, result: "already-verified" }));
  process.exit(0);
}
const history = await coolify(`/deployments/applications/${uuid}`);
assert.ok(!history.deployments.some((job) => ["queued", "in_progress"].includes(job.status)), "A preview deployment is already active.");
await verifyHead();
console.log(JSON.stringify({ pr, app: uuid, url: domain, previousTag: app.docker_registry_image_tag,
  candidateTag: tag, result: "prepared" }));
if (app.docker_registry_image_tag !== tag) await coolify(path, "PATCH", { docker_registry_image_tag: tag });
assert.equal((await coolify(path)).docker_registry_image_tag, tag);
const result = await coolify("/deploy", "POST", { uuid });
assert.equal(result.deployments.length, 1);
assert.equal(result.deployments[0].resource_uuid, uuid);
const deployment = result.deployments[0].deployment_uuid;
assert.match(deployment ?? "", /^[a-z0-9]{20,32}$/);
console.log(JSON.stringify({ pr, app: uuid, deployment, url: domain, result: "queued" }));
for (let attempt = 0; attempt < 36; attempt++) {
  const observed = await coolify(`/deployments/${deployment}`);
  assert.ok(["queued", "in_progress", "finished"].includes(observed.status), `Preview deployment ended as ${observed.status}.`);
  if (observed.status === "finished" && (await coolify(path)).status === "running:healthy" && await verifiesLive()) {
    console.log(JSON.stringify({ pr, app: uuid, deployment, url: domain, frontendCommit: receipt.frontendCommit,
      cloudCommit: receipt.cloudCommit, image: receipt.image, result: "verified" }));
    process.exit(0);
  }
  await setTimeout(5000);
}
throw new Error(`Preview ${deployment} did not verify. Read back that deployment before retrying.`);
