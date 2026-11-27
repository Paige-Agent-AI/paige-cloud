import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectWorkload, inspectionContract } from "./service.mjs";

const scope = {
  organization: "00000000-0000-0000-0000-000000000001",
  project: "test-project",
  application: "second-app",
  environment: "development"
};
const release = { commit: "a".repeat(40), candidate: "a" };
const dataVersion = "version-1";
const request = { operation: inspectionContract };
const config = { schema: "paige.cloud.workload.config.v1", ready: true, ...scope };

function inspect(readObject) {
  return inspectWorkload({ scope, release, dataVersion, readObject });
}

function object(record, version = dataVersion) {
  const content = JSON.stringify(record);
  return { version, size: Buffer.byteLength(content), text: async () => content };
}

test("reports health only after reading the pinned scoped backend version", async () => {
  const result = await inspect(async () => object(config))(request);
  assert.equal(result.state, "healthy");
  assert.deepEqual(result.scope, scope);
  assert.deepEqual(result.release, release);
  assert.equal(result.objectVersion, dataVersion);
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
});

test("fails closed for stale, cross-organization, and invalid backend data", async () => {
  const inputs = [
    object(config, "other-version"),
    object({ ...config, organization: "other-organization" }),
    object({ ...config, ready: false }),
    object({ ...config, filler: "x".repeat(4096) })
  ];
  for (const input of inputs) {
    const result = await inspect(async () => input)(request);
    assert.equal(result.state, "unavailable");
    assert.equal(result.objectVersion, undefined);
  }
});

test("does not expose provider failures or accept caller-selected backend targets", async () => {
  let reads = 0;
  const handler = inspect(async () => {
    reads++;
    throw new Error("private provider details");
  });
  assert.deepEqual(await handler({ ...request, scope }), {
    schema: inspectionContract, state: "unsupported_operation"
  });
  assert.equal(reads, 0);
  const failure = await handler(request);
  assert.equal(failure.state, "unavailable");
  assert.ok(!JSON.stringify(failure).includes("private provider details"));
  assert.equal(reads, 1);
});

test("classifies an actual provider 403 and keeps provider details private", async () => {
  const providerError = Object.assign(new Error("internal object identity"), {
    name: "AccessDenied", $metadata: { httpStatusCode: 403 }
  });
  const result = await inspect(async () => { throw providerError; })(request);
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "backend_access_denied");
  assert.ok(!JSON.stringify(result).includes("internal object identity"));
});
