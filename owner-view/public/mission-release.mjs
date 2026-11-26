const commit = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
export const releaseScope = "/organizations/paige/projects/paige-agent-ai/environments/production";

// Read-only projection of the existing production reader. A Git ref is not a release intent.
export function releaseEvidence(production, { now = Date.now(), staleAfter = 120_000, failed = false } = {}) {
  const checked = typeof production?.checkedAt === "string" ? Date.parse(production.checkedAt) : NaN;
  if (failed) return { state: "unavailable" };
  if (!Number.isFinite(checked) || checked > now + 5_000) return { state: "unavailable" };
  if (now - checked >= staleAfter) return { state: "stale" };
  if (production.identity === "mismatch") return { state: "conflicting" };
  const serving = production.identity === "matched" && commit(production.frontendCommit);
  if (!serving) return { state: "unavailable" };
  const main = commit(production.mainCommit);
  const receipt = commit(production.receiptCommit) === serving;
  const health = ["healthy", "unhealthy"].includes(production.state) ? production.state : "unavailable";
  return { state: receipt ? "verified" : "receipt-unavailable", serving, main, health,
    checkedAt: production.checkedAt, receiptCoverage: production.providerSource === "available" &&
      production.receiptSource === "available" ? "available" : "limited" };
}
