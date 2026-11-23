import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { previewUrlFor } from "../owner-view/pr-previews.mjs";

const receiptPath = process.argv[2];
assert.ok(receiptPath, "Usage: node scripts/deploy-pr-preview.mjs <paige-pr-preview.json>");
const automated = process.env.PAIGE_PREVIEW_AUTOMATED === "true";
const token = automated ? process.env.PAIGE_PREVIEW_COOLIFY_TOKEN : process.env.COOLIFY_CLOUD_TOKEN;
assert.ok(token, automated ? "Set the preview-only Coolify token." : "Use the existing approved Cloud operator credential.");
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
if (automated) {
  assert.equal(String(pr), process.env.PAIGE_PREVIEW_PULL_REQUEST);
  assert.equal(receipt.frontendCommit, process.env.PAIGE_PREVIEW_HEAD);
  assert.equal(receipt.cloudCommit, process.env.GITHUB_SHA);
  assert.equal(receipt.tag, `pr-${pr}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
}
const digest = /^ghcr\.io\/paige-agent-ai\/paige-agent-ai-pr-preview@sha256:([a-f0-9]{64})$/.exec(receipt.image ?? "")?.[1];
assert.ok(digest, "The preview-only registry digest is required.");
const tag = `sha256-${digest}`;
const domain = previewUrlFor(pr, !automated);
const name = `paige-pr-preview-${pr}`;
const project = automated ? process.env.PAIGE_PREVIEW_PROJECT : "mvokcozpkh3u8grmordxzjly";
const environment = automated ? process.env.PAIGE_PREVIEW_ENVIRONMENT : "igihntzdp7htuxz6yqxdx3ql";
const environmentName = automated ? "pull-requests" : "f2-preview";
const destination = automated ? process.env.PAIGE_PREVIEW_DESTINATION : "qhj2gr632xrfotx24vphy98v";
const server = automated ? process.env.PAIGE_PREVIEW_SERVER : "p2mh5nemklmkmb6rtnuw8swd";
const resourceId = /^[a-z0-9]{20,32}$/;
for (const id of [project, environment, destination, server]) assert.match(id ?? "", resourceId);
const coolifyBase = "https://app.coolify.io/api/v1";
const coolifyHeaders = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };

async function getJson(url, options) {
  const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${url} returned HTTP ${response.status}.`);
  return response.json();
}

function coolify(path, method = "GET", body) {
  return getJson(coolifyBase + path, {
    method,
    headers: coolifyHeaders,
    body: body && JSON.stringify(body),
  });
}

async function verifyPreviewScope() {
  const projects = await coolify("/projects");
  assert.ok(Array.isArray(projects) && projects.length === 1 && projects[0].uuid === project,
    "Preview automation requires access to its dedicated Coolify project only.");
  const denied = ["/team", "/applications/qucl8euvl1vjcg1z3nryqadb",
    "/applications/izwrky18u9ixdhstnulxpjs5", "/applications/vnh5vfaqnq0fkkgfalgda8gx"];
  for (const path of denied) {
    const response = await fetch(coolifyBase + path, {
      headers: coolifyHeaders, redirect: "error", signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    assert.ok(response.status === 403 || response.status === 404, `Preview credential has unexpected access at ${path}.`);
  }
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
if (automated) await verifyPreviewScope();

const env = await coolify(`/projects/${project}/${environmentName}`);
assert.equal(env.uuid, environment);
let matches = env.applications.filter((app) => app.name === name);
assert.ok(matches.length <= 1, "More than one app uses this PR preview address.");
if (!matches.length) {
  const created = await coolify("/applications/dockerimage", "POST", {
    project_uuid: project, environment_uuid: environment, server_uuid: server, destination_uuid: destination,
    name, domains: domain, noindex_domains: [domain], docker_registry_image_name: image, docker_registry_image_tag: tag,
    ports_exposes: "8080", health_check_enabled: true, health_check_path: "/healthz", health_check_port: 8080,
    health_check_return_code: 200, limits_memory: "128m", limits_cpus: "0.25", instant_deploy: false,
    is_force_https_enabled: true, is_preview_deployments_enabled: false,
  });
  matches = [created];
}
const { uuid } = matches[0];
assert.match(uuid ?? "", resourceId);
const path = `/applications/${uuid}`;
const app = await coolify(path);
assert.equal(app.uuid, uuid);
assert.match(String(app.id), /^[1-9][0-9]*$/);
assert.equal(app.name, name);
assert.equal(app.fqdn, domain);
assert.equal(app.environment_id, env.id);
assert.equal(app.build_pack, "dockerimage");
assert.equal(app.docker_registry_image_name, image);
assert.equal(app.ports_exposes, "8080");
assert.equal(app.health_check_path, "/healthz");
if (automated) assert.equal(app.health_check_enabled, true);
const destinations = await coolify(`${path}/destinations`);
assert.deepEqual(destinations.map((item) => item.uuid), [destination]);
assert.deepEqual(await coolify(`${path}/envs`), [], "A visual preview must have no configured environment variables.");

async function verifiesLive() {
  try {
    const [manifest, health] = await Promise.all([
      getJson(`${domain}/release.json`),
      fetch(`${domain}/healthz`, { redirect: "error", signal: AbortSignal.timeout(10000) }),
    ]);
    const healthy = (await health.text()).trim() === "ok" && health.status === 200;
    return healthy && manifest.frontendCommit === receipt.frontendCommit && manifest.cloudCommit === receipt.cloudCommit;
  } catch { return false; }
}

if (app.docker_registry_image_tag === tag && app.status === "running:healthy" && await verifiesLive()) {
  console.log(JSON.stringify({ pr, url: domain, frontendCommit: receipt.frontendCommit, result: "already-verified" }));
  process.exit(0);
}
const history = await coolify(`/deployments/applications/${uuid}`);
const inFlight = (rows) => rows.filter((job) => ["queued", "in_progress"].includes(job.status));
const active = inFlight(history.deployments);
await verifyHead();
let deployment;
if (active.length) {
  assert.ok(active.length === 1 && app.docker_registry_image_tag === tag, "Another preview deployment is already active.");
  assert.equal(String(active[0].application_id), String(app.id));
  deployment = active[0].deployment_uuid;
} else {
  console.log(JSON.stringify({ pr, app: uuid, url: domain, previousTag: app.docker_registry_image_tag,
    candidateTag: tag, result: "prepared" }));
  if (app.docker_registry_image_tag !== tag) await coolify(path, "PATCH", { docker_registry_image_tag: tag });
  assert.equal((await coolify(path)).docker_registry_image_tag, tag);
  const nextHistory = await coolify(`/deployments/applications/${uuid}`);
  const newRollout = nextHistory.deployments[0];
  if (newRollout && newRollout.deployment_uuid !== history.deployments[0]?.deployment_uuid) {
    assert.equal(String(newRollout.application_id), String(app.id));
    deployment = newRollout.deployment_uuid;
  } else {
    const result = await coolify("/deploy", "POST", { uuid });
    assert.equal(result.deployments.length, 1);
    assert.equal(result.deployments[0].resource_uuid, uuid);
    deployment = result.deployments[0].deployment_uuid;
  }
}
assert.match(deployment ?? "", resourceId);
console.log(JSON.stringify({ pr, app: uuid, deployment, url: domain, result: "queued" }));
const deadline = performance.now() + (automated ? 16 : 3) * 60_000;
while (performance.now() < deadline) {
  const observed = await coolify(`/deployments/${deployment}`);
  assert.equal(observed.deployment_uuid, deployment);
  assert.equal(String(observed.application_id), String(app.id));
  assert.ok(["queued", "in_progress", "finished"].includes(observed.status), `Preview deployment ended as ${observed.status}.`);
  if (observed.status === "finished") {
    const running = await coolify(path);
    if (running.status === "running:healthy" && running.docker_registry_image_tag === tag &&
        observed.configuration_hash && running.config_hash === observed.configuration_hash && await verifiesLive()) {
      await verifyHead();
      console.log(JSON.stringify({ pr, app: uuid, deployment, url: domain, frontendCommit: receipt.frontendCommit,
        cloudCommit: receipt.cloudCommit, image: receipt.image, result: "verified" }));
      process.exit(0);
    }
  }
  await setTimeout(5000);
}
throw new Error(`Preview ${deployment} did not verify. Read back that deployment before retrying.`);
