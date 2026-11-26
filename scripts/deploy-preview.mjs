import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [candidatePath, priorPath] = process.argv.slice(2);
const appUuid = process.env.COOLIFY_PREVIEW_APP_UUID;
const token = process.env.COOLIFY_CLOUD_TOKEN;
const imageRepo = "ghcr.io/paige-agent-ai/paige-cloud-preview";
const appName = "paige-cloud-f2";
const project = "mvokcozpkh3u8grmordxzjly";
const environmentName = "f2-preview";
const serverName = "paige-cloud-preview";
const digestRef = /^ghcr\.io\/paige-agent-ai\/paige-cloud-preview@sha256:([a-f0-9]{64})$/;
assert.match(appUuid ?? "", /^[a-z0-9]{20,32}$/);
assert.ok(token, "Obtain Coolify access from the approved secret store.");
assert.ok(candidatePath && priorPath, "Usage: deploy-preview.mjs <candidate.json> <previous.json|bootstrap>");

function readRelease(path) {
  const release = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(release.environment, "cloud-preview");
  assert.match(release.cloudCommit ?? "", /^[a-f0-9]{40}$/);
  assert.match(release.frontendCommit ?? "", /^[a-f0-9]{40}$/);
  const digest = release.image?.match(digestRef)?.[1];
  assert.ok(digest, "An immutable digest from the private Cloud package is required.");
  assert.match(release.run ?? "", /^https:\/\/github\.com\/Paige-Agent-AI\/paige-cloud(?:-preview)?\/actions\/runs\/\d+$/i);
  assert.ok(typeof release.review === "string" && release.review.trim(), "An exact-source review reference is required.");
  return { ...release, tag: `sha256-${digest}` };
}

async function coolify(path, method = "GET", data) {
  const response = await fetch(`https://app.coolify.io/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: data && JSON.stringify(data),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`Coolify ${method} ${path} returned HTTP ${response.status}.`);
  }
  return response.json();
}

const candidate = readRelease(candidatePath);
const previous = priorPath === "bootstrap" ? null : readRelease(priorPath);
const url = `https://${appUuid}.179.66.154.248.sslip.io`;
const appPath = `/applications/${appUuid}`;
const verifyScript = fileURLToPath(new URL("./verify-preview.mjs", import.meta.url));

function verifyEndpoint(release) {
  execFileSync(process.execPath, [
    verifyScript,
    url,
    release.cloudCommit,
    release.frontendCommit,
  ], { stdio: "inherit" });
}

const environment = await coolify(`/projects/${project}/${environmentName}`);
assert.equal(environment.name, environmentName);
assert.ok(Number.isInteger(environment.id));

function confirmApp(app) {
  assert.equal(app.uuid, appUuid);
  assert.equal(app.name, appName);
  assert.equal(app.environment_id, environment.id);
  assert.equal(app.fqdn, url);
  assert.equal(app.build_pack, "dockerimage");
  assert.equal(app.docker_registry_image_name, imageRepo);
  assert.equal(app.ports_exposes, "8080");
  assert.equal(app.health_check_enabled, true);
  assert.equal(app.health_check_path, "/healthz");
  assert.equal(app.settings?.is_auto_deploy_enabled, false);
}

const app = await coolify(appPath);
confirmApp(app);
const history = (await coolify(`/deployments/applications/${appUuid}`)).deployments;
assert.ok(Array.isArray(history));
assert.ok(!history.some((job) => /^(queued|in_progress)$/.test(job.status)), "A deployment is still active.");

if (previous) {
  assert.equal(app.docker_registry_image_tag, previous.tag, "Saved digest differs from the prior release.");
  assert.notEqual(candidate.tag, previous.tag, "The candidate is already selected.");
  verifyEndpoint(previous);
  await coolify(appPath, "PATCH", { docker_registry_image_tag: candidate.tag });
} else {
  assert.equal(history.length, 0, "Bootstrap is only available before the first deployment.");
  assert.equal(app.docker_registry_image_tag, candidate.tag, "Create the new application using the first approved digest.");
}
const saved = await coolify(appPath);
confirmApp(saved);
assert.equal(saved.docker_registry_image_tag, candidate.tag);

const queued = await coolify("/deploy", "POST", { uuid: appUuid });
const deployment = queued.deployments?.find((job) => job.resource_uuid === appUuid)?.deployment_uuid;
assert.match(deployment ?? "", /^[a-z0-9]{20,32}$/);
console.log(JSON.stringify({
  observedAt: new Date().toISOString(), appUuid, deployment, url, result: "queued",
  image: candidate.image, rollbackTarget: previous?.image ?? null,
}));

for (let attempt = 0; attempt < 60; attempt++) {
  const status = await coolify(`/deployments/${deployment}`);
  if (status.status === "finished") {
    assert.equal(status.deployment_uuid, deployment);
    assert.equal(String(status.application_id), String(app.id));
    assert.equal(status.server_name, serverName);
    const pullWitness = `Starting deployment of ${candidate.image} to ${serverName}.`;
    assert.ok(typeof status.logs === "string" && status.logs.includes(pullWitness),
      "The expected immutable image reference is missing from the deployment logs. Check log permission and inspect live state before retrying.");
    const current = await coolify(appPath);
    confirmApp(current);
    assert.equal(current.docker_registry_image_tag, candidate.tag);
    verifyEndpoint(candidate);
    console.log(JSON.stringify({
      observedAt: new Date().toISOString(), appUuid, deployment, url, result: status.status,
      finishedAt: status.finished_at,
      ...candidate, tag: undefined, pullWitness, rollbackTarget: previous?.image ?? null,
    }));
    process.exit(0);
  }
  if (!["queued", "in_progress"].includes(status.status)) {
    throw new Error(`Deployment ${deployment} ended with status ${status.status}. Follow the recovery runbook.`);
  }
  await setTimeout(5000);
}
throw new Error(`Deployment ${deployment} did not finish within five minutes. Check Coolify before retrying.`);
