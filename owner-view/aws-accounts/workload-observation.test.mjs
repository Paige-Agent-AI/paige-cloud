import assert from "node:assert/strict";
import test from "node:test";
import { createWorkloadObservation, inspectionCapability, parseInspectionScope } from "./workload-observation.mjs";

const organization = "00000000-0000-4000-8000-000000000001";
const scope = parseInspectionScope(`${organization}/work/fixture/development`);
const records = [{ id: scope.application, environments: ["development", "preview"] }];
const now = Date.parse("2026-11-27T12:00:00Z");
const release = { commit: "a".repeat(40), candidate: "a" };

function fixture({ compute, admission = "reserved", kind = "execute" } = {}) {
  const calls = [];
  const result = {
    StatusCode: 200, ExecutedVersion: "1",
    Payload: Buffer.from(JSON.stringify({ schema: inspectionCapability, check: "scoped_object", state: "healthy",
      scope, release, observedAt: new Date(now).toISOString(), objectVersion: "internal" }))
  };
  const inspection = createWorkloadObservation({
    scope,
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
