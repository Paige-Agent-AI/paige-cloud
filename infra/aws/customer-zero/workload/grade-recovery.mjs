import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// PAIGE Agent AI 79e2f303, supabase/functions/_shared/eval/trajectory-registry.ts.
const evaluatorDigest = "bb84db8c0c04aace17618fcdfb98a76ff99b00d22f4e9ec9ad7f59a3202c398";

function sameScope(first, second) {
  return first && second && ["organization", "project", "application", "environment"]
    .every(key => typeof first[key] === "string" && first[key] && first[key] === second[key]);
}

// Criteria are specific to the verified Cloud drill. Original PAIGE Intelligence owns
// the verdict semantics. This operator tool consumes already verified provider receipts.
export function gradeRecovery(facts, evaluatorVerdict) {
  const { baseline, fault, approval, recovered } = facts;
  const plan = fault?.incident?.plan;
  const grade = (complete, condition) => evaluatorVerdict("applicable",
    complete ? "complete" : "missing", complete ? (condition ? "met" : "not_met") : "unknown");
  return {
    diagnosis: grade(fault?.evidence?.sha256 && fault?.incident?.reason,
      sameScope(fault?.scope, baseline?.scope) && fault.state === "unavailable" &&
      fault.incident.reason === "backend_access_denied"),
    scopedPlanning: grade(plan && baseline?.release?.commit && fault?.evidence?.sha256,
      sameScope(plan?.scope, baseline?.scope) && plan.status === "review_required" &&
      plan.operation === "restore_verified_alias" && plan.fromVersion === fault?.release?.version &&
      plan.target?.version === baseline.release?.version && plan.target?.commit === baseline.release?.commit &&
      plan.evidenceSha256 === fault?.evidence?.sha256),
    authorizedExecution: grade(approval?.reviewedChangeSet && approval?.executedChangeSet && plan?.target,
      approval?.reviewedChangeSet === approval?.executedChangeSet && approval?.targetVersion === plan?.target?.version &&
      approval?.fromVersion === plan?.fromVersion && approval?.stackStatus === "UPDATE_COMPLETE"),
    independentRecovery: grade(recovered?.codeSha256 && recovered?.observedAt && baseline?.codeSha256 && approval?.executedAt,
      sameScope(recovered?.scope, baseline?.scope) && recovered?.state === "healthy" &&
      baseline?.state === "healthy" &&
      recovered?.release?.version === baseline?.release?.version && recovered?.release?.commit === baseline?.release?.commit &&
      recovered?.codeSha256 === baseline?.codeSha256 && Date.parse(recovered?.observedAt) >= Date.parse(approval?.executedAt))
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
