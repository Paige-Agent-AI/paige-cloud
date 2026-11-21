import { readFileSync } from "node:fs";

const repository = "Paige-Agent-AI/Paige-Agent-AI";
export const productionHosts = ["paigeagent.ai", "www.paigeagent.ai", "app.paigeagent.ai"];
const app = "qucl8euvl1vjcg1z3nryqadb";
const commit = /^[a-f0-9]{40}$/;
const deployment = /^[a-z0-9]{20,32}$/;
const numericId = /^[1-9][0-9]{0,19}$/;
const image = /^ghcr\.io\/paige-agent-ai\/(paige-agent-ai-web|paige-cloud-preview)@sha256:[a-f0-9]{64}$/;
const check = (pattern, value) => typeof value === "string" && pattern.exec(value)?.[0] === value;

export function verifiedProductionReceipts(evidence) {
  if (!Array.isArray(evidence)) return [];
  const records = [];
  const runs = new Set();
  const deployments = new Set();
  for (const row of evidence) {
    const approvedDomains = productionHosts.map((host) => "https://" + host).sort();
    if (row?.schema !== 1 || row.repository !== repository || row.environment !== "paige-coolify-production" ||
        row.appId !== app || row.result !== "verified" || row.providerStatus !== "finished" || row.stage !== "live-verification" ||
        !Array.isArray(row.domains) || row.domains.length !== approvedDomains.length ||
        ![...row.domains].sort().every((domain, index) => approvedDomains[index] === domain) ||
        !check(commit, row.candidate?.commit) || !check(image, row.candidate?.image) ||
        !row.candidate.image.startsWith("ghcr.io/paige-agent-ai/paige-agent-ai-web@") ||
        !check(commit, row.previous?.frontendCommit) || !check(image, row.previous?.image) ||
        !check(deployment, row.deployment) || !check(deployment, row.previous?.deployment) ||
        row.deployment === row.previous.deployment || row.candidate.image === row.previous.image ||
        !check(numericId, row.workflow?.runId) || !check(numericId, row.workflow?.attempt) ||
        !check(numericId, row.artifactId) || !check(numericId, row.approval?.ciRun) ||
        !Number.isSafeInteger(row.approval?.pullRequest) || row.approval.pullRequest < 1 ||
        typeof row.finishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(row.finishedAt) ||
        !Number.isFinite(Date.parse(row.finishedAt))) return [];
    const run = row.workflow.runId + "/" + row.workflow.attempt;
    if (runs.has(run) || deployments.has(row.deployment)) return [];
    runs.add(run);
    deployments.add(row.deployment);
    records.push({
      finishedAt: new Date(row.finishedAt).toISOString(),
      commit: row.candidate.commit,
      image: row.candidate.image,
      deployment: row.deployment,
      runId: row.workflow.runId,
      attempt: row.workflow.attempt,
      pullRequest: row.approval.pullRequest,
      rollback: {
        commit: row.previous.frontendCommit,
        image: row.previous.image,
        deployment: row.previous.deployment,
      },
    });
  }
  return records.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 20);
}

function loadReceipts() {
  try {
    return verifiedProductionReceipts(JSON.parse(readFileSync(new URL("./production-receipts.json", import.meta.url), "utf8")));
  } catch {
    return [];
  }
}

export const productionReceipts = loadReceipts();
