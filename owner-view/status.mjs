import { readFileSync } from "node:fs";
import { productionHosts, productionReceipts } from "./production-receipts.mjs";

const evidence = JSON.parse(readFileSync(new URL("./release-ledger.json", import.meta.url), "utf8"));
const appId = "izwrky18u9ixdhstnulxpjs5";
const previewOrigin = "https://izwrky18u9ixdhstnulxpjs5.179.66.154.248.sslip.io";
const providerOrigin = "https://app.coolify.io/api/v1";
const imagePackage = "ghcr.io/paige-agent-ai/paige-cloud-preview";
const deploymentId = /^[a-z0-9]{20,32}$/;
const commitId = /^[a-f0-9]{40}$/;
const visibleStatuses = new Set(["queued", "in_progress", "finished", "failed", "cancelled", "cancelled-by-user"]);
const releaseByDeployment = new Map(evidence.deployments.map((row) => [row.id, row]));

async function readBody(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty provider response");
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Provider response exceeded size limit");
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normaliseHistory(data) {
  if (!Array.isArray(data?.deployments)) return null;
  const entries = data.deployments.slice(0, 10).map((row) => {
    if (!deploymentId.test(row?.deployment_uuid ?? "")) return null;
    const recorded = releaseByDeployment.get(row.deployment_uuid);
    const finishedAt = isoDate(row.finished_at);
    const createdAt = isoDate(row.created_at);
    if (!createdAt) return null;
    const matched = row.status === "finished" && recorded && finishedAt === isoDate(recorded.finishedAt);
    const release = matched ? evidence.releases[recorded.release] : null;
    const elapsed = finishedAt ? Date.parse(finishedAt) - Date.parse(createdAt) : -1;
    const source = release && evidence.frontendSources[release.frontendCommit];
    return {
      id: row.deployment_uuid,
      status: visibleStatuses.has(row.status) ? row.status : "unknown",
      at: finishedAt ?? createdAt,
      createdAt,
      elapsedSeconds: elapsed >= 0 ? Math.floor(elapsed / 1000) : null,
      event: matched ? recorded.event : null,
      release: release?.name ?? null,
      frontendCommit: release?.frontendCommit ?? null,
      cloudCommit: release?.cloudCommit ?? null,
      imageDigest: release?.imageDigest ?? null,
      source: source || null,
      run: release?.run ?? null,
      code: matched ? recorded.release : null,
    };
  });
  if (entries.includes(null) || new Set(entries.map((row) => row.id)).size !== entries.length) return null;
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function identityOf(app, manifest, history) {
  if (!app || !manifest || !history) return { identity: "unavailable", current: null, rollback: null };
  const [live, next] = history;
  const release = live?.code ? evidence.releases[live.code] : null;
  const digestHex = release?.imageDigest.split(":")[1];
  if (!release || live.createdAt === next?.createdAt || app.docker_registry_image_tag !== "sha256-" + digestHex ||
      manifest.cloudCommit !== release.cloudCommit || manifest.frontendCommit !== release.frontendCommit) {
    return { identity: "unconfirmed", current: null, rollback: null };
  }
  const older = history.find((row) => row.code && row.code !== live.code);
  return {
    identity: "verified",
    current: { ...release, verifiedAt: live.at },
    rollback: older ? { ...evidence.releases[older.code], verifiedAt: older.at } : null,
  };
}

export async function readPreviewStatus(token, fetchFrom = fetch) {
  const request = (url, headers) => fetchFrom(url, {
    method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(6500),
  });
  const provider = { Authorization: "Bearer " + token, Accept: "application/json" };
  const readJson = async (url, headers, limit) => {
    const response = await request(url, headers);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Source unavailable");
    }
    return JSON.parse(await readBody(response, limit));
  };
  const [appResult, historyResult, manifestResult, healthResult] = await Promise.allSettled([
    readJson(providerOrigin + "/applications/" + appId, provider, 256 * 1024),
    readJson(providerOrigin + "/deployments/applications/" + appId + "?take=10", provider, 512 * 1024),
    readJson(previewOrigin + "/release.json", { Accept: "application/json" }, 8192),
    (async () => {
      const response = await request(previewOrigin + "/healthz", { Accept: "text/plain" });
      const body = await readBody(response, 1024);
      return { httpStatus: response.status, healthy: response.status === 200 && body.trim() === "ok" };
    })(),
  ]);
  const appData = appResult.value;
  const app = appData?.uuid === appId && appData.name === "paige-cloud-f2" && appData.fqdn === previewOrigin &&
      appData.docker_registry_image_name === imagePackage ? appData : null;
  const history = normaliseHistory(historyResult.value);
  const manifestData = manifestResult.value;
  const manifest = manifestData?.schema === 1 && manifestData.environment === "cloud-preview" &&
    commitId.test(manifestData.cloudCommit ?? "") && commitId.test(manifestData.frontendCommit ?? "")
    ? manifestData : null;
  const observed = healthResult.value;
  const providerHealth = app?.status === "running:healthy" ? "healthy" :
    typeof app?.status === "string" && /^(running|exited|restarting):(unhealthy|starting)$/.test(app.status)
      ? "unhealthy" : "unavailable";
  const health = {
    state: observed?.healthy === false || providerHealth === "unhealthy" ? "unhealthy" :
      observed?.healthy && providerHealth === "healthy" ? "healthy" : "unavailable",
    httpStatus: observed?.httpStatus ?? null,
    provider: providerHealth,
  };
  return {
    checkedAt: new Date().toISOString(),
    health,
    ...identityOf(app, manifest, history),
    history: history?.map(({ createdAt, code, ...row }) => row) ?? null,
  };
}

export async function readProductionStatus(fetchFrom = fetch) {
  const request = (url, type) => fetchFrom(url, {
    method: "GET", headers: { Accept: type }, redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(6500),
  });

  const domains = await Promise.all(productionHosts.map(async (hostname) => {
    const origin = "https://" + hostname;
    const [health, source] = await Promise.allSettled([
      (async () => {
        const response = await request(origin + "/healthz", "text/plain");
        if (response.status !== 200) {
          await response.body?.cancel();
          return { state: "unhealthy", httpStatus: response.status };
        }
        const healthy = (await readBody(response, 1024)).trim() === "ok";
        return { state: healthy ? "healthy" : "unhealthy", httpStatus: response.status };
      })(),
      (async () => {
        const response = await request(origin + "/release.json", "application/json");
        if (response.status !== 200) {
          await response.body?.cancel();
          return null;
        }
        const manifest = JSON.parse(await readBody(response, 8192));
        return typeof manifest?.frontendCommit === "string" && commitId.test(manifest.frontendCommit) &&
          typeof manifest.cloudCommit === "string" && commitId.test(manifest.cloudCommit)
          ? { frontendCommit: manifest.frontendCommit, cloudCommit: manifest.cloudCommit } : null;
      })(),
    ]);
    return {
      hostname,
      state: health.value?.state ?? "unavailable",
      httpStatus: health.value?.httpStatus ?? null,
      frontendCommit: source.value?.frontendCommit ?? null,
      cloudCommit: source.value?.cloudCommit ?? null,
    };
  }));

  const sources = domains.filter((domain) => domain.frontendCommit);
  const revisions = new Set(sources.map(({ frontendCommit, cloudCommit }) => `${frontendCommit}:${cloudCommit}`));
  const identity = revisions.size > 1 ? "mismatch" : sources.length === domains.length ? "matched" : "unavailable";
  const frontend = identity === "matched" ? sources[0].frontendCommit : null;
  const matchingReceipt = frontend && frontend === sources[0].cloudCommit &&
    productionReceipts.find((receipt) => receipt.commit === frontend);
  return {
    checkedAt: new Date().toISOString(),
    state: domains.every((domain) => domain.state === "healthy") ? "healthy" :
      domains.some((domain) => domain.state === "unhealthy") ? "unhealthy" : "unavailable",
    identity,
    frontendCommit: frontend,
    receipts: productionReceipts,
    receiptCommit: matchingReceipt?.commit ?? null,
    domains,
  };
}

export async function readOwnerStatus(token, fetchFrom = fetch) {
  const [preview, production] = await Promise.all([
    readPreviewStatus(token, fetchFrom), readProductionStatus(fetchFrom),
  ]);
  return { ...preview, production };
}
