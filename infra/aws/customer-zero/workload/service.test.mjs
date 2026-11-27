import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectWorkload, inspectionContract } from "./service.mjs";
import { encodeSettings } from "./settings.mjs";

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

function settingsFixture(target, revision, configuration) {
  const { key, body, digest } = encodeSettings(target, {
    revision, configuration, savedAt: "2026-11-27T00:00:00Z"
  });
  const version = `settings-${revision}`;
  return { key, pin: { version, revision, digest }, object: { version, size: body.length, bytes: () => body } };
}

test("consumes each immutable settings pin and can recover an earlier one", async () => {
  const first = settingsFixture(scope, 32, { logLevel: "info", requestTimeoutMs: 2000 });
  const next = settingsFixture(scope, 33, { logLevel: "error", requestTimeoutMs: 100 });
  for (const snapshot of [first, next, first]) {
    const entries = [];
    const handler = inspectWorkload({ scope, release, dataVersion, settingsPin: snapshot.pin,
      readSettings(key, version) {
        assert.equal(key, snapshot.key);
        assert.equal(version, snapshot.pin.version);
        return snapshot.object;
      },
      async readObject(signal) {
        await new Promise((resolve, reject) => {
          const delay = setTimeout(resolve, 150);
          signal.addEventListener("abort", () => {
            clearTimeout(delay);
            reject(signal.reason);
          }, { once: true });
        });
        return object(config);
      },
      log(...entry) { entries.push(entry); }
    });
    const result = await handler(request);
    assert.deepEqual(result.configuration, snapshot.pin);
    assert.equal(result.state, snapshot === first ? "healthy" : "unavailable");
    assert.deepEqual(entries, snapshot === first ? [["info", "backend_read_verified"]] : []);
  }
});

test("rejects swapped settings and a revoked read before application data access", async () => {
  const good = settingsFixture(scope, 1, { logLevel: "info", requestTimeoutMs: 500 });
  const otherScope = { ...scope, organization: "00000000-0000-0000-0000-000000000002" };
  const otherTenant = settingsFixture(otherScope, 1, { logLevel: "info", requestTimeoutMs: 500 });
  const otherEnvironment = settingsFixture({ ...scope, environment: "preview" }, 1, { logLevel: "info", requestTimeoutMs: 500 });
  const accessDenied = Object.assign(new Error("bucket details"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  const cases = [
    [otherTenant.pin, () => otherTenant.object, "configuration_unverified"],
    [otherEnvironment.pin, () => otherEnvironment.object, "configuration_unverified"],
    [good.pin, () => otherEnvironment.object, "configuration_unverified"],
    [{ ...good.pin, revision: 2 }, () => good.object, "configuration_unverified"],
    [good.pin, () => ({ ...good.object, version: "latest" }), "configuration_unverified"],
    [good.pin, () => { throw accessDenied; }, "configuration_access_denied"]
  ];
  let backendReads = 0;
  for (const [settingsPin, readSettings, reason] of cases) {
    const handler = inspectWorkload({ scope, release, dataVersion, settingsPin, readSettings,
      readObject() { backendReads++; return object(config); } });
    const result = await handler(request);
    assert.equal(result.reason, reason);
    assert.equal(result.configuration, undefined);
    assert.ok(!JSON.stringify(result).includes("bucket details"));
  }
  assert.equal(backendReads, 0);
});
