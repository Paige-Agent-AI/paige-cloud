import assert from "node:assert/strict";
import test from "node:test";
import { gradeRecovery } from "./grade-recovery.mjs";

function fixture() {
  const scope = { organization: "fixture", project: "example", application: "probe", environment: "development" };
  const at = minute => `2026-11-27T12:0${minute}:00Z`;
  const codeSha256 = `${"a".repeat(43)}=`;
  const release = { version: "1", commit: "a".repeat(40) };
  const sha256 = "f".repeat(64);
  const changeSet = "arn:aws:cloudformation:us-east-2:000000000000:changeSet/restore/00000000-0000-0000-0000-000000000000";
  const baseline = { scope, state: "healthy", release, codeSha256, observedAt: at(0) };
  return {
    baseline,
    fault: { scope, release: { version: "3" }, observedAt: at(1), state: "unavailable", evidence: { sha256 },
      incident: { reason: "backend_access_denied", plan: {
        status: "review_required", operation: "restore_verified_alias", scope, fromVersion: "3", target: release, evidenceSha256: sha256
      } } },
    approval: { reviewedChangeSet: changeSet, executedChangeSet: changeSet, fromVersion: "3",
      targetVersion: "1", executedAt: at(2), stackStatus: "UPDATE_COMPLETE" },
    recovered: { ...baseline, observedAt: at(3) }
  };
}

const verdict = (_applicability, evidence, condition) => evidence === "missing" ? "indeterminate"
  : condition === "met" ? "pass" : "fail";

test("complete linked evidence passes each drill criterion", () => {
  const checks = gradeRecovery(fixture(), verdict);
  assert.deepEqual(Object.values(checks), ["pass", "pass", "pass", "pass"]);
});

test("missing incident, approval target, and release fields never pass or throw", () => {
  const incomplete = fixture();
  delete incomplete.fault.incident;
  delete incomplete.approval.targetVersion;
  delete incomplete.recovered.release;
  assert.deepEqual(Object.values(gradeRecovery(incomplete, verdict)), Array(4).fill("indeterminate"));
  const noTarget = fixture();
  delete noTarget.approval.fromVersion;
  assert.equal(gradeRecovery(noTarget, verdict).authorizedExecution, "indeterminate");
});

test("wrong scope, plan evidence, executed change set and restored digest each fail", () => {
  const wrong = fixture();
  wrong.fault.scope = { ...wrong.fault.scope, organization: "other" };
  wrong.fault.incident.plan.evidenceSha256 = "c".repeat(64);
  wrong.approval.executedChangeSet = wrong.approval.executedChangeSet.replace("restore", "other");
  wrong.recovered.codeSha256 = `${"c".repeat(43)}=`;
  assert.deepEqual(Object.values(gradeRecovery(wrong, verdict)), Array(4).fill("fail"));
});
