import assert from "node:assert/strict";
import test from "node:test";
import { createWorkloadObservation, inspectionCapability, releaseInventoryCapability, parseInspectionRecoveryPoint, parseInspectionScope } from "./workload-observation.mjs";

const organization = "00000000-0000-4000-8000-000000000001";
const scope = parseInspectionScope(`${organization}/work/fixture/development`);
const records = [{ id: scope.application, environments: ["development", "preview"] }];
const now = Date.parse("2026-11-27T12:00:00Z");
const aliasArn = "arn:aws:lambda:us-east-2:000000000001:function:independent:live";
const release = { commit: "a".repeat(40), candidate: "a" };

function fixture({ compute, admission = "reserved", kind = "execute", recoveryPoint, readReleases } = {}) {
  const calls = [];
  const result = {
    StatusCode: 200, ExecutedVersion: "1",
    Payload: Buffer.from(JSON.stringify({ schema: inspectionCapability, check: "scoped_object", state: "healthy",
      scope, release, observedAt: new Date(now).toISOString(), objectVersion: "internal" }))
  };
  const inspection = createWorkloadObservation({
    scope, recoveryPoint, aliasArn,
    ...(readReleases && { async readReleases() { calls.push(["versions"]); return readReleases(); } }),
    now: () => now,
    decide(input) { calls.push(["decision", input]); return { kind, args: input.requestArgs }; },
    async reserve(actor, actual) { calls.push(["reserve", actor, actual]); return admission; },
    async invoke(args) { calls.push(["invoke", args]); return compute ? compute(result) : result; }
  });
  return { inspection, calls };
}

test("a registered scope passes through Spine, cost reservation, one invoke and validated evidence", async () => {
  const { inspection, calls } = fixture();
  const result = await inspection.inspect("verified-actor", scope, records);
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(([step]) => step), ["decision", "reserve", "invoke"]);
  assert.equal(calls[0][1].caller.tenantId, organization);
  assert.equal(calls[0][1].caller.tenantSource, "server");
  assert.equal(calls[0][1].capability.effect, "read");
  assert.deepEqual(calls[2][1], { operation: inspectionCapability });
  assert.deepEqual(result.observation.release, { ...release, version: "1" });
  assert.match(result.observation.evidence.sha256, /^[a-f\d]{64}$/);
  assert.equal(JSON.stringify(result).includes("internal"), false);
});

test("foreign scope, unbound environment, revoked grant, denied decision and exhausted allowance consume no provider work", async () => {
  for (const [selector, applications, options, status, steps] of [
    [{ ...scope, organization: organization.replace(/1$/, "2") }, records, {}, 404, []],
    [{ ...scope, environment: "preview" }, records, {}, 404, []],
    [scope, null, {}, 404, []],
    [scope, records, { kind: "refuse" }, 403, ["decision"]],
    [scope, records, { admission: null }, 404, ["decision", "reserve"]],
    [scope, records, { admission: "limited" }, 429, ["decision", "reserve"]]
  ]) {
    const { inspection, calls } = fixture(options);
    assert.deepEqual(await inspection.inspect("verified-actor", selector, applications), { status });
    assert.deepEqual(calls.map(([step]) => step), steps);
  }
});

test("reports the consumed revision and digest without exposing storage metadata", async () => {
  const configuration = { revision: 33, digest: "b".repeat(64), version: "private-settings-version" };
  const verify = revision => fixture({ compute: result => ({
    ...result,
    Payload: Buffer.from(JSON.stringify({ ...JSON.parse(result.Payload), configuration: { ...configuration, revision } }))
  }) }).inspection.inspect("verified-actor", scope, records);
  const reply = await verify(33);
  assert.deepEqual(reply.observation.consumedConfiguration, { revision: 33, digest: configuration.digest });
  assert.ok(!JSON.stringify(reply).includes(configuration.version));
  assert.deepEqual(await verify(0), { status: 503 });
});

test("provider errors, wrong scope, and stale response never become a verified health observation", async () => {
  for (const compute of [
    () => { throw new Error("sensitive provider error"); },
    result => ({ ...result, FunctionError: "Unhandled" }),
    result => ({ ...result, Payload: Buffer.from(result.Payload.toString().replace(organization, organization.replace(/1$/, "2"))) }),
    result => ({ ...result, Payload: Buffer.from(result.Payload.toString().replace("2026-11-27T12:00", "2026-11-27T11:00")) })
  ]) {
    const { inspection, calls } = fixture({ compute });
    assert.deepEqual(await inspection.inspect("verified-actor", scope, records), { status: 503 });
    assert.equal(calls.filter(([step]) => step === "invoke").length, 1);
  }
});

test("an observed AWS denial proposes only the prior scoped trusted recovery point", async () => {
  const recoveryPoint = parseInspectionRecoveryPoint(`1/${"b".repeat(40)}`);
  const compute = result => ({
    ...result, ExecutedVersion: "3",
    Payload: Buffer.from(JSON.stringify({ ...JSON.parse(result.Payload), state: "unavailable", reason: "backend_access_denied",
      release: { ...release, candidate: "drill" } }))
  });
  const { inspection, calls } = fixture({ compute, recoveryPoint });
  const result = await inspection.inspect("verified-actor", scope, records);
  assert.equal(result.status, 200);
  assert.deepEqual(result.observation.incident, { reason: "backend_access_denied", plan: {
    operation: "restore_verified_alias", status: "review_required", scope, fromVersion: "3",
    target: recoveryPoint, evidenceSha256: result.observation.evidence.sha256
  } });
  assert.equal(calls.filter(([step]) => step === "invoke").length, 1);

  const sameVersion = fixture({ compute, recoveryPoint: { ...recoveryPoint, version: "3" } });
  assert.deepEqual((await sameVersion.inspection.inspect("verified-actor", scope, records)).observation.incident,
    { reason: "backend_access_denied" });
});

const alias = { AliasArn: aliasArn, FunctionVersion: "5", RevisionId: "alias-revision" };
const providerVersion = (version, pins = {}) => ({
  Version: version,
  FunctionArn: aliasArn.replace(/live$/, version),
  CodeSha256: "a".repeat(43) + "=",
  LastModified: "2026-11-27T09:00:00.000+0000",
  Description: "internal metadata",
  Role: "internal role",
  Environment: { Variables: {
    CLOUD_WORKLOAD_ORGANIZATION: scope.organization, CLOUD_WORKLOAD_PROJECT: scope.project,
    CLOUD_WORKLOAD_APPLICATION: scope.application, CLOUD_WORKLOAD_ENVIRONMENT: scope.environment,
    HIDDEN_VALUE: "internal variable", ...pins
  } }
});
const providerPage = () => ({
  before: alias, after: alias,
  versions: { Versions: [{ Version: "$LATEST" }, providerVersion("5", {
    CLOUD_SETTINGS_REVISION: "1", CLOUD_SETTINGS_DIGEST: "b".repeat(64), CLOUD_SETTINGS_VERSION: "internal s3 version"
  }), providerVersion("12")] }
});

test("release inventory uses the exact admitted scope and returns only stable, immutable metadata", async () => {
  const { inspection, calls } = fixture({ readReleases: providerPage });
  const reply = await inspection.listReleases("verified-actor", scope, records);
  assert.equal(reply.status, 200);
  assert.equal(reply.inventory.liveAliasVersion, "5");
  assert.equal(reply.inventory.completeness, "complete");
  assert.deepEqual(reply.inventory.versions.map(row => [row.version, row.pinnedRevision]), [["12", null], ["5", 1]]);
  assert.equal(reply.inventory.versions[0].lastModified, "2026-11-27T09:00:00.000Z");
  assert.deepEqual(calls.map(([step]) => step), ["decision", "reserve", "versions"]);
  assert.equal(calls[0][1].capability.id, releaseInventoryCapability);
  assert.equal(JSON.stringify(reply).includes("internal"), false);
});

test("release inventory has no provider calls for foreign scopes, denied grants and exhausted allowances", async () => {
  for (const [selector, applications, options, status, steps] of [
    [{ ...scope, organization: organization.replace(/1$/, "2") }, records, {}, 404, []],
    [{ ...scope, environment: "preview" }, records, {}, 404, []],
    [scope, null, {}, 404, []],
    [scope, records, { kind: "refuse" }, 403, ["decision"]],
    [scope, records, { admission: "limited" }, 429, ["decision", "reserve"]]
  ]) {
    const { inspection, calls } = fixture({ ...options, readReleases: providerPage });
    assert.deepEqual(await inspection.listReleases("verified-actor", selector, applications), { status });
    assert.deepEqual(calls.map(([step]) => step), steps);
  }
});

test("release inventory rejects changing or weighted aliases and foreign or incomplete version records", async () => {
  for (const transform of [
    page => ({ ...page, after: { ...page.after, RevisionId: "another-revision" } }),
    page => ({ ...page, after: { ...page.after, RoutingConfig: { AdditionalVersionWeights: { 12: 0.2 } } } }),
    page => ({ ...page, versions: { Versions: [providerVersion("5", { CLOUD_WORKLOAD_ENVIRONMENT: "preview" })] } }),
    page => ({ ...page, versions: { Versions: [providerVersion("5", { CLOUD_SETTINGS_REVISION: "2" })] } }),
    page => ({ ...page, versions: { Versions: [providerVersion("12")] } })
  ]) {
    const { inspection } = fixture({ readReleases: () => transform(providerPage()) });
    assert.deepEqual(await inspection.listReleases("verified-actor", scope, records), { status: 503 });
  }
  const { inspection } = fixture({ readReleases: () => ({
    ...providerPage(), versions: { Versions: [providerVersion("12")], NextMarker: "internal-cursor" }
  }) });
  const partial = await inspection.listReleases("verified-actor", scope, records);
  assert.equal(partial.inventory.completeness, "partial");
  assert.equal(partial.inventory.liveAliasVersion, null);
  assert.equal(JSON.stringify(partial).includes("internal-cursor"), false);
});
