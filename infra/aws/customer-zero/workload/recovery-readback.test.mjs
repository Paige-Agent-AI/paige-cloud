import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyRecoveryTarget } from "./recovery-readback.mjs";

const now = Date.parse("2026-11-27T15:30:04Z");
const runtimeRead = {
  schema: "paige.cloud.workload.inspect.v1", state: "healthy", observedAt: "2026-11-27T15:30:02Z",
  scope: { organization: "org-a", project: "test", application: "probe", environment: "development" },
  release: { candidate: "a", commit: "a".repeat(40) },
  check: "scoped_object", objectVersion: "private-version-id"
};
const fixture = {
  expected: {
    functionArn: "arn:aws:lambda:us-east-2:123456789012:function:private-test",
    alias: "live",
    scope: { organization: "org-a", project: "test", application: "probe", environment: "development" },
    version: "1", commit: "a".repeat(40), codeSha256: "A".repeat(43) + "="
  },
  startedAt: "2026-11-27T15:30:00Z",
  invocation: { StatusCode: 200, ExecutedVersion: "1", Payload: JSON.stringify(runtimeRead) },
  configuration: {
    FunctionArn: "arn:aws:lambda:us-east-2:123456789012:function:private-test:1", Version: "1",
    State: "Active", CodeSha256: "A".repeat(43) + "="
  },
  aliasBefore: {
    AliasArn: "arn:aws:lambda:us-east-2:123456789012:function:private-test:live", FunctionVersion: "1",
    RevisionId: "initial"
  },
  aliasAfter: {
    AliasArn: "arn:aws:lambda:us-east-2:123456789012:function:private-test:live", FunctionVersion: "1",
    RevisionId: "initial"
  }
};

test("reports verified current health with the exact release and bounded readback evidence", () => {
  const result = verifyRecoveryTarget(fixture, now);
  assert.deepEqual(result, {
    state: "target_verified", observedAt: new Date(runtimeRead.observedAt).toISOString(),
    release: { version: "1", commit: fixture.expected.commit, codeSha256: fixture.expected.codeSha256 },
    evidenceSha256: createHash("sha256").update(fixture.invocation.Payload).digest("hex")
  });
});

test("holds changed aliases, weighted routing and wrong immutable versions unverified", () => {
  assert.equal(verifyRecoveryTarget({ ...fixture, aliasAfter: { ...fixture.aliasAfter, RevisionId: "replaced" } }, now)
    .reason, "alias_not_pinned");
  const RoutingConfig = { AdditionalVersionWeights: { "2": 0.2 } };
  assert.equal(verifyRecoveryTarget({ ...fixture, aliasBefore: { ...fixture.aliasBefore, RoutingConfig } }, now).reason,
    "alias_not_pinned");
  assert.equal(verifyRecoveryTarget({ ...fixture, configuration: { ...fixture.configuration, CodeSha256: "B".repeat(43) + "=" } }, now)
    .reason, "immutable_version_mismatch");
});

test("holds stale, unhealthy, foreign and unverified observations without a retry signal", () => {
  assert.deepEqual(verifyRecoveryTarget(fixture, now + 31_000),
    { state: "unverified", reason: "stale_or_missing_observation" });
  const badInvocations = [
    { ExecutedVersion: "2" }, { FunctionError: "Unhandled" }, { Payload: "not json" },
    ...[{ state: "unavailable" }, { scope: { ...runtimeRead.scope, organization: "org-b" } },
      { objectVersion: null }, { observedAt: "2026-11-27T15:29:50Z" }]
      .map(change => ({ Payload: JSON.stringify({ ...runtimeRead, ...change }) }))
  ];
  for (const change of badInvocations) {
    assert.deepEqual(verifyRecoveryTarget({ ...fixture, invocation: { ...fixture.invocation, ...change } }, now),
      { state: "unverified", reason: "runtime_observation_mismatch" });
  }
  assert.deepEqual(verifyRecoveryTarget(null, now), { state: "unverified", reason: "invalid_target" });
});
