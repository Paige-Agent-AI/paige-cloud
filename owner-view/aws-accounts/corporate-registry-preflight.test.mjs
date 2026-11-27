import assert from "node:assert/strict";
import test from "node:test";
import { checkCorporateRegistry, registerCorporateProjects } from "./corporate-registry-preflight.mjs";

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

test("imports missing metadata through the normal registry writer and a repeat adds nothing", async () => {
  const matching = new Set();
  const locks = [];
  const execute = async (sql, params) => {
    if (sql.includes("FOR SHARE")) { locks.push("owner"); return "owner"; }
    if (sql.includes("FOR UPDATE")) { locks.push("organization"); return "corporate"; }
    if (sql.includes("registry_create_project")) {
      matching.add(params.project);
      return JSON.stringify({ id: params.project, name: params.name, role: "owner" });
    }
    return JSON.stringify(JSON.parse(params.products).map(product => ({
      ...product, state: matching.has(product.id) ? "matching" : "missing",
    })));
  };
  const initial = await registerCorporateProjects({ ...binding, execute });
  const repeated = await registerCorporateProjects({ ...binding, execute });
  assert.equal(initial.state, "import_verified");
  assert.equal(initial.additions, 8);
  assert.deepEqual(repeated, { ...initial, additions: 0 });
  assert.deepEqual(locks, ["owner", "organization", "owner", "organization"]);
});

test("holds conflicts before any write and throws on an unexpected writer result", async () => {
  const execute = conflict => async (sql, params) => {
    if (sql.includes("FOR SHARE")) return "owner";
    if (sql.includes("FOR UPDATE")) return "corporate";
    if (sql.includes("registry_create_project")) {
      assert.equal(conflict, false);
      return JSON.stringify({ error: "registry_limit" });
    }
    return JSON.stringify(JSON.parse(params.products).map((product, index) => ({
      ...product, state: conflict && index === 0 ? "conflict" : "missing",
    })));
  };
  assert.equal((await registerCorporateProjects({ ...binding, execute: execute(true) })).state, "conflict");
  await assert.rejects(registerCorporateProjects({ ...binding, execute: execute(false) }), /expected project/);
  assert.deepEqual(await registerCorporateProjects({ ...binding, execute: async () => undefined }),
    { state: "binding_unverified" });
});
