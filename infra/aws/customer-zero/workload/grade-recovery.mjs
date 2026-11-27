import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// PAIGE Agent AI 79e2f303, supabase/functions/_shared/eval/trajectory-registry.ts.
const evaluatorDigest = "bb84db8c0c04aace17618fcddfb98a76ff99b00d22f4e9ec9ad7f59a3202c398";

function sameScope(first, second) {
  return first && second && ["organization", "project", "application", "environment"]
    .every(key => typeof first[key] === "string" && first[key] && first[key] === second[key]);
}

const version = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
const commit = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const payloadDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const lambdaDigest = value => typeof value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const changeSet = value => typeof value === "string" && /^arn:aws:cloudformation:[a-z0-9-]+:\d{12}:changeSet\/.+\/[a-f0-9-]{36}$/.test(value);

// Criteria are specific to the verified Cloud drill. Original PAIGE Intelligence owns
// the verdict semantics. This operator tool consumes already verified provider receipts.
export function gradeRecovery(facts, evaluatorVerdict) {
  const { baseline, fault, approval, recovered } = facts;
  const plan = fault?.incident?.plan;
  const baselineComplete = sameScope(baseline?.scope, baseline?.scope) && version(baseline?.release?.version) &&
    commit(baseline?.release?.commit) && lambdaDigest(baseline?.codeSha256) && instant(baseline?.observedAt) &&
    typeof baseline?.state === "string";
  const faultComplete = sameScope(fault?.scope, fault?.scope) && version(fault?.release?.version) && instant(fault?.observedAt) &&
    payloadDigest(fault?.evidence?.sha256) && typeof fault?.incident?.reason === "string" && typeof fault?.state === "string";
  const planComplete = sameScope(plan?.scope, plan?.scope) && typeof plan?.status === "string" &&
    typeof plan?.operation === "string" && version(plan.fromVersion) && version(plan.target?.version) &&
    commit(plan.target?.commit) && payloadDigest(plan.evidenceSha256);
  const approvalComplete = changeSet(approval?.reviewedChangeSet) && changeSet(approval?.executedChangeSet) &&
    version(approval.fromVersion) && version(approval.targetVersion) && instant(approval.executedAt) &&
    typeof approval.stackStatus === "string";
  const recoveryComplete = sameScope(recovered?.scope, recovered?.scope) && version(recovered?.release?.version) &&
    commit(recovered?.release?.commit) && lambdaDigest(recovered?.codeSha256) && instant(recovered?.observedAt) &&
    typeof recovered?.state === "string";
  const grade = (complete, condition) => evaluatorVerdict("applicable",
    complete ? "complete" : "missing", complete ? (condition() ? "met" : "not_met") : "unknown");
  return {
    diagnosis: grade(baselineComplete && faultComplete, () =>
      sameScope(fault.scope, baseline.scope) && baseline.state === "healthy" && fault.state === "unavailable" &&
      fault.release.version !== baseline.release.version && Date.parse(fault.observedAt) >= Date.parse(baseline.observedAt) &&
      fault.incident.reason === "backend_access_denied"),
    scopedPlanning: grade(baselineComplete && faultComplete && planComplete, () =>
      sameScope(plan.scope, baseline.scope) && sameScope(plan.scope, fault.scope) &&
      plan.status === "review_required" && plan.operation === "restore_verified_alias" &&
      plan.fromVersion === fault.release.version && plan.target.version === baseline.release.version &&
      plan.target.commit === baseline.release.commit && plan.evidenceSha256 === fault.evidence.sha256),
    authorizedExecution: grade(faultComplete && planComplete && approvalComplete, () =>
      approval.reviewedChangeSet === approval.executedChangeSet && approval.targetVersion === plan.target.version &&
      approval.fromVersion === plan.fromVersion && approval.stackStatus === "UPDATE_COMPLETE" &&
      Date.parse(approval.executedAt) >= Date.parse(fault.observedAt)),
    independentRecovery: grade(baselineComplete && approvalComplete && recoveryComplete, () =>
      sameScope(recovered.scope, baseline.scope) && recovered.state === "healthy" && baseline.state === "healthy" &&
      recovered.release.version === baseline.release.version && recovered.release.commit === baseline.release.commit &&
      recovered.codeSha256 === baseline.codeSha256 && Date.parse(recovered.observedAt) >= Date.parse(approval.executedAt))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , source, receipt] = process.argv;
  if (!source || !receipt) throw new Error("Supply the exact evaluator source and verified drill receipt");
  const bytes = readFileSync(source);
  if (createHash("sha256").update(bytes).digest("hex") !== evaluatorDigest) throw new Error("Unreviewed evaluator source");
  const code = stripTypeScriptTypes(bytes.toString("utf8"), { mode: "strip" });
  const { evaluatorVerdict } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const checks = gradeRecovery(JSON.parse(readFileSync(receipt, "utf8")), evaluatorVerdict);
  console.log(JSON.stringify(checks));
  if (!Object.values(checks).every(verdict => verdict === "pass")) process.exitCode = 1;
}
