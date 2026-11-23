import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { crc32, inflateRawSync } from "node:zlib";
import { productionReceipts, verifiedProductionReceipts } from "./production-receipts.mjs";

const repository = "Paige-Agent-AI/Paige-Agent-AI";
const repositoryId = 1207965608;
const workflow = "paige-coolify.yml";
const github = `https://api.github.com/repos/${repository}`;
const coolify = "https://app.coolify.io/api/v1";
const app = "qucl8euvl1vjcg1z3nryqadb";
const receiptName = "paige-production-receipt.json";
const maxArchive = 128 * 1024;
const maxReceipt = 32 * 1024;
const historyLimit = 200;
const providerPageSize = 10;
const maxProviderPage = 8 * 1024 * 1024;
const providerStates = new Set(["queued", "in_progress", "finished", "failed", "cancelled", "cancelled-by-user"]);
const commitPattern = /^[a-f0-9]{40}$/;
const deploymentPattern = /^[a-z0-9]{20,32}$/;
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const runKey = (id, attempt) => `${id}/${attempt}`;

async function readBytes(response, maximum) {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new Error("Production history source unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > maximum) throw new Error("Production history response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function zipReceipt(zip) {
  const end = zip.length - 22;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) ||
      zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== 1 || zip.readUInt16LE(end + 10) !== 1 ||
      zip.readUInt16LE(end + 20)) throw new Error("Unexpected production receipt archive");
  const directory = zip.readUInt32LE(end + 16);
  if (directory + 46 > end || directory + zip.readUInt32LE(end + 12) !== end ||
      zip.readUInt32LE(directory) !== 0x02014b50 || zip.readUInt32LE(directory + 42) !== 0 ||
      zip.readUInt16LE(directory + 34) || zip.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP directory");
  const flags = zip.readUInt16LE(directory + 8);
  const method = zip.readUInt16LE(directory + 10);
  const crc = zip.readUInt32LE(directory + 16);
  const compressed = zip.readUInt32LE(directory + 20);
  const uncompressed = zip.readUInt32LE(directory + 24);
  const localName = zip.readUInt16LE(26);
  const data = 30 + localName + zip.readUInt16LE(28);
  const directoryName = zip.readUInt16LE(directory + 28);
  if (flags & ~0x80e || flags !== zip.readUInt16LE(6) || ![0, 8].includes(method) || method !== zip.readUInt16LE(8) ||
      uncompressed > maxReceipt || data + compressed > directory ||
      directory + 46 + directoryName + zip.readUInt16LE(directory + 30) + zip.readUInt16LE(directory + 32) !== end ||
      zip.subarray(30, 30 + localName).toString() !== receiptName ||
      zip.subarray(directory + 46, directory + 46 + directoryName).toString() !== receiptName) {
    throw new Error("Invalid production receipt ZIP entry");
  }
  const content = zip.subarray(data, data + compressed);
  const plain = method === 8 ? inflateRawSync(content, { maxOutputLength: maxReceipt }) : content;
  if (plain.length !== uncompressed || crc32(plain) !== crc) throw new Error("Production receipt ZIP integrity check failed");
  return JSON.parse(plain.toString("utf8"));
}

function readJson(fetchFrom, url, headers, signal, maximum) {
  return fetchFrom(url, { headers, signal, redirect: "error", cache: "no-store" })
    .then((response) => readBytes(response, maximum)).then((bytes) => JSON.parse(bytes.toString("utf8")));
}

async function fetchReceipt(fetchFrom, headers, signal, run) {
  const name = `paige-production-receipt-${run.id}-${run.run_attempt}`;
  const list = await readJson(fetchFrom, `${github}/actions/runs/${run.id}/artifacts?name=${name}&per_page=2`,
    headers, signal, 64 * 1024);
  if (!Array.isArray(list.artifacts) || list.artifacts.length > 1) throw new Error("Ambiguous GitHub receipt artifact");
  if (!list.artifacts.length) return null;
  const [artifact] = list.artifacts;
  if (artifact?.expired === true) return null;
  if (!validId(artifact?.id) || artifact.name !== name || artifact.expired !== false ||
      !validId(artifact.size_in_bytes) || artifact.size_in_bytes > maxArchive) throw new Error("Invalid GitHub receipt artifact");
  const source = artifact.workflow_run;
  if (!source || source.id !== run.id || source.head_sha !== run.head_sha ||
      source.repository_id !== run.repository.id || source.head_repository_id !== run.repository.id ||
      source.head_branch !== "main") throw new Error("GitHub receipt source does not match the run");
  const download = await fetchFrom(`${github}/actions/artifacts/${artifact.id}/zip`,
    { headers, signal, redirect: "manual", cache: "no-store" });
  await download.body?.cancel();
  if (download.status !== 302) throw new Error("GitHub receipt download unavailable");
  const location = new URL(download.headers.get("location"));
  if (location.protocol !== "https:" || location.port || location.username || location.password || location.hash ||
      !/^[a-z0-9][a-z0-9.-]*\.(?:blob\.core\.windows\.net|actions\.githubusercontent\.com)$/.test(location.hostname)) {
    throw new Error("GitHub receipt download host unavailable");
  }
  const zip = await readBytes(await fetchFrom(location, { signal, redirect: "error", cache: "no-store" }), maxArchive);
  if (artifact.digest != null && artifact.digest !== `sha256:${createHash("sha256").update(zip).digest("hex")}`) {
    throw new Error("GitHub receipt artifact digest does not match");
  }
  const evidence = zipReceipt(zip);
  if (evidence?.workflow?.runId !== String(run.id) || evidence.workflow.attempt !== String(run.run_attempt) ||
      evidence.candidate?.commit !== run.head_sha) throw new Error("Production receipt does not match the GitHub run");
  const [receipt] = verifiedProductionReceipts([{ ...evidence, artifactId: String(artifact.id) }]);
  if (!receipt) throw new Error("Production receipt verification failed");
  return receipt;
}

async function refreshReceipts(fetchFrom, token, known, retain) {
  const signal = AbortSignal.timeout(30_000);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "PAIGE-Cloud" };
  const batches = await Promise.allSettled(["workflow_run", "workflow_dispatch"].map((event) => readJson(fetchFrom,
    `${github}/actions/workflows/${workflow}/runs?branch=main&event=${event}&status=success&per_page=25`, headers, signal, 768 * 1024)));
  const candidates = new Map();
  let sourceCount = 0;
  for (const batch of batches) {
    if (batch.status !== "fulfilled" || !Array.isArray(batch.value?.workflow_runs)) continue;
    sourceCount++;
    for (const run of batch.value.workflow_runs.slice(0, 25)) {
      if (run?.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
          run.repository.id !== repositoryId || run.head_repository.id !== repositoryId ||
          run.path !== `.github/workflows/${workflow}` || run.head_branch !== "main" ||
          !["workflow_run", "workflow_dispatch"].includes(run.event) || run.status !== "completed" || run.conclusion !== "success" ||
          !validId(run.id) || !validId(run.run_attempt) || typeof run.head_sha !== "string" || !commitPattern.test(run.head_sha)) continue;
      const key = runKey(run.id, run.run_attempt);
      if (!known.has(key)) candidates.set(key, run);
    }
  }
  if (!sourceCount) return "unavailable";
  let partial = sourceCount < batches.length;
  const runs = [...candidates.values()];
  for (let i = 0; i < runs.length && !signal.aborted; i += 4) {
    await Promise.all(runs.slice(i, i + 4).map(async (run) => {
      try {
        const receipt = await fetchReceipt(fetchFrom, headers, signal, run);
        if (receipt) retain(receipt);
      } catch { partial = true; }
    }));
  }
  return partial || signal.aborted ? "partial" : "available";
}

function isoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}

async function readProvider(fetchFrom, token) {
  const signal = AbortSignal.timeout(8000);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const deployments = new Map();
  const take = providerPageSize;
  try {
    for (let skip = 0; skip < historyLimit; skip += take) {
      const page = await readJson(fetchFrom, `${coolify}/deployments/applications/${app}?skip=${skip}&take=${take}`,
        headers, signal, maxProviderPage);
      if (!Array.isArray(page?.deployments) || page.deployments.length > take) throw new Error("Invalid Coolify history");
      for (const row of page.deployments) {
        const id = row?.deployment_uuid;
        const created = isoDate(row?.created_at);
        if (typeof id !== "string" || !deploymentPattern.test(id) || !created || deployments.has(id)) {
          throw new Error("Ambiguous Coolify history page");
        }
        const finished = isoDate(row.finished_at);
        const status = providerStates.has(row.status) ? row.status : "unknown";
        deployments.set(id, { id, status, created, at: finished ?? created,
          elapsedSeconds: finished && finished >= created ? Math.floor((Date.parse(finished) - Date.parse(created)) / 1000) : null });
      }
      if (page.deployments.length < take) return { deployments: [...deployments.values()], providerSource: "available" };
    }
  } catch {
    if (!deployments.size) return { deployments: [], providerSource: "unavailable" };
  }
  return { deployments: [...deployments.values()], providerSource: "partial" };
}

export function createProductionHistory({ actionsToken, coolifyToken, filename = ":memory:", fetchFrom = fetch, clock = Date.now } = {}) {
  for (const token of [actionsToken, coolifyToken]) {
    if (token && (typeof token !== "string" || !/^[\x21-\x7e]{16,512}$/.test(token))) throw new Error("Invalid production history credential");
  }
  const db = actionsToken ? new DatabaseSync(filename, { timeout: 1000 }) : null;
  db?.exec(`CREATE TABLE IF NOT EXISTS production_receipts (
    deployment TEXT PRIMARY KEY, run_key TEXT UNIQUE NOT NULL, finished_at TEXT NOT NULL, payload TEXT NOT NULL
  )`);
  const save = db?.prepare("INSERT OR IGNORE INTO production_receipts VALUES (?, ?, ?, ?)");
  const list = db?.prepare("SELECT payload FROM production_receipts ORDER BY finished_at DESC LIMIT ?");
  const saved = db?.prepare("SELECT run_key FROM production_receipts");
  let closed = false;
  let receiptSource = actionsToken ? "checking" : "unconfigured";
  let receiptRefreshAt = -Infinity;
  let receiptRefresh;
  let providerRefreshAt = -Infinity;
  let providerRefresh;
  let provider = { deployments: [], providerSource: coolifyToken ? "checking" : "unconfigured" };

  function readReceipts() {
    const merged = new Map(productionReceipts.map((receipt) => [receipt.deployment, receipt]));
    for (const row of list?.all(historyLimit) ?? []) {
      const receipt = JSON.parse(row.payload);
      if (!merged.has(receipt.deployment)) merged.set(receipt.deployment, receipt);
    }
    return [...merged.values()].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, historyLimit);
  }

  function refreshGitHub() {
    if (actionsToken && !closed && !receiptRefresh && clock() >= receiptRefreshAt) {
      const known = new Set([...(saved?.all().map((row) => row.run_key) ?? []),
        ...productionReceipts.map((receipt) => runKey(receipt.runId, receipt.attempt))]);
      receiptRefresh = refreshReceipts(fetchFrom, actionsToken, known, (receipt) => {
        if (!closed) save.run(receipt.deployment, runKey(receipt.runId, receipt.attempt), receipt.finishedAt, JSON.stringify(receipt));
      }).then((state) => { receiptSource = state; }, () => { receiptSource = "unavailable"; }).finally(() => {
        receiptRefreshAt = clock() + (receiptSource === "available" ? 180_000 : 60_000);
        receiptRefresh = undefined;
      });
    }
  }

  const timer = actionsToken ? setInterval(refreshGitHub, 60_000) : undefined;
  timer?.unref();

  async function read() {
    refreshGitHub();
    if (coolifyToken && !closed && !providerRefresh && clock() >= providerRefreshAt) {
      providerRefresh = readProvider(fetchFrom, coolifyToken).then((result) => {
        provider = result.providerSource === "unavailable" && provider.deployments.length
          ? { ...provider, providerSource: "stale" } : result;
        providerRefreshAt = clock() + 45_000;
      }).finally(() => { providerRefresh = undefined; });
    }
    await providerRefresh;
    return { ...provider, receiptSource, receipts: readReceipts() };
  }

  return { read, close() { closed = true; clearInterval(timer); db?.close(); } };
}
