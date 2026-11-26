import assert from "node:assert/strict";
import test from "node:test";
import { releaseEvidence } from "./public/mission-release.mjs";

const now = Date.parse("2026-11-26T12:00:00Z");
const serving = "a".repeat(40);
const main = "b".repeat(40);
const observed = { checkedAt: new Date(now).toISOString(), state: "healthy", identity: "matched",
  frontendCommit: serving, mainCommit: main, receiptCommit: null, receiptSource: "available", providerSource: "available" };

test("missing receipt does not mean failed rollout or promote GitHub main to release intent", () => {
  assert.deepEqual(releaseEvidence(observed, { now }), {
    state: "receipt-unavailable", serving, main, health: "healthy",
    checkedAt: observed.checkedAt, receiptCoverage: "available",
  });
  assert.equal(releaseEvidence({ ...observed, receiptCommit: serving }, { now }).state, "verified");
  assert.equal(releaseEvidence({ ...observed, receiptCommit: main }, { now }).state, "receipt-unavailable");
  assert.equal(releaseEvidence({ ...observed, mainCommit: serving }, { now }).state, "receipt-unavailable");
  assert.equal(releaseEvidence({ ...observed, receiptSource: "unavailable" }, { now }).receiptCoverage, "limited");
});

test("stale, conflicting and unavailable evidence withhold a current comparison", () => {
  for (const [data, options, state] of [
    [observed, { now: now + 120_000 }, "stale"], [observed, { now, failed: true }, "unavailable"],
    [{ ...observed, checkedAt: new Date(now + 6_000).toISOString() }, { now }, "unavailable"],
    [{ ...observed, identity: "mismatch" }, { now }, "conflicting"],
    [{ ...observed, identity: "unavailable" }, { now }, "unavailable"],
    [{ ...observed, frontendCommit: `<img src=x>` }, { now }, "unavailable"],
    [null, { now }, "unavailable"],
  ]) assert.deepEqual(releaseEvidence(data, options), { state });
});
