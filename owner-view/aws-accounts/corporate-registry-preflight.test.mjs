import assert from "node:assert/strict";
import test from "node:test";
import { checkCorporateRegistry } from "./corporate-registry-preflight.mjs";

const binding = {
  organization: "11111111-1111-4111-8111-111111111111",
  owner: "22222222-2222-4222-8222-222222222222",
};

test("reads one exact corporate scope and returns only the approved product metadata", async () => {
  let reads = 0;
  const report = await checkCorporateRegistry({ ...binding, async execute(sql, params) {
    reads++;
    assert.deepEqual({ organization: params.organization, owner: params.owner }, binding);
    assert.equal(params.company, "PAIGE Agent AI Inc.");
    assert.match(sql, /membership.role = 'owner' AND membership.revoked_at IS NULL/);
    assert.match(sql, /project.organization_id = organization.id/);
    assert.match(sql, /grant_entry.account_id = CAST\(:owner AS uuid\)/);
    const products = JSON.parse(params.products);
    return JSON.stringify(products.map((product, index) =>
      ({ ...product, state: ["matching", "conflict", "missing"][Math.min(index, 2)], ignored: "private" })));
  } });
  assert.equal(reads, 1);
  assert.equal(report.state, "binding_verified");
  assert.equal(report.projects.length, 8);
  assert.deepEqual(report.projects[0], { id: "paige-cloud", name: "PAIGE Cloud", state: "matching" });
  assert.equal(report.projects[1].state, "conflict");
  assert.equal(report.projects[2].state, "missing");
  assert.equal(JSON.stringify(report).includes("private"), false);
});

test("does not infer corporate ownership on missing, malformed or contradictory evidence", async () => {
  assert.deepEqual(await checkCorporateRegistry({ ...binding, execute: async () => undefined }),
    { state: "binding_unverified" });
  await assert.rejects(checkCorporateRegistry({ ...binding, owner: "guessed-owner", execute: () => assert.fail("queried") }),
    /Exact corporate organization and named owner IDs are required/);
  await assert.rejects(checkCorporateRegistry({ ...binding, async execute(_sql, { products }) {
    return JSON.stringify(JSON.parse(products).map(product => ({ ...product, state: "assumed" })));
  } }), /Unexpected corporate project readback/);
});
