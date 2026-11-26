import assert from "node:assert/strict";
import test from "node:test";
import { bindingState, createBindingTargets } from "./provider-bindings.mjs";

const scope = { organizationId: "example", projectId: "demo", environmentId: "development", applicationId: "worker" };
const entry = { ...scope, id: "approved-target", provider: "coolify", resourceId: "f".repeat(24), version: 1 };

test("approval applies to exact scope and disappears on revocation or identity/version drift", () => {
  const targets = createBindingTargets(JSON.stringify([entry]));
  const [target] = targets(scope);
  const binding = { targetId: entry.id, targetFingerprint: target.fingerprint };
  assert.equal(bindingState(binding, targets(scope)), "bound");
  for (const field of Object.keys(scope)) assert.deepEqual(targets({ ...scope, [field]: "foreign" }), []);
  assert.equal(bindingState(binding, createBindingTargets(undefined)(scope)), "approval-unavailable");
  for (const delta of [{ version: 2 }, { resourceId: "e".repeat(24) }]) {
    assert.equal(bindingState(binding, createBindingTargets(JSON.stringify([{ ...entry, ...delta }]))(scope)), "approval-unavailable");
  }
  assert.equal(Object.hasOwn(target, "resourceId"), false);
});

test("rejects scope aliasing, duplicate IDs, URLs and extra fields", () => {
  for (const values of [[entry, { ...entry }], [entry, { ...entry, projectId: "foreign" }],
    [{ ...entry, resourceId: "https://example.test" }], [{ ...entry, token: "not-allowed" }]]) {
    assert.throws(() => createBindingTargets(JSON.stringify(values)), /provider target/i);
  }
  assert.throws(() => createBindingTargets("invalid confidential input"), { message: "Invalid provider target configuration" });
});
