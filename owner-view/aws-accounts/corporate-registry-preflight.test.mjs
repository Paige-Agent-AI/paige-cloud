import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    assert.equal(params.company, "PAIGE Cloud");
    assert.deepEqual(JSON.parse(params.superseded), ["paige-cloud", "paige-drive", "presentation-room"]);
    assert.match(sql, /membership.role = 'owner' AND membership.revoked_at IS NULL/);
    assert.match(sql, /project.organization_id = organization.id/);
    assert.match(sql, /grant_entry.account_id = CAST\(:owner AS uuid\)/);
    const products = JSON.parse(params.products);
    return JSON.stringify({ legacyProjects: [], projects: products.map((product, index) =>
      ({ ...product, state: ["matching", "conflict", "missing"][Math.min(index, 2)], ignored: "private" })) });
  } });
  assert.equal(reads, 1);
  assert.equal(report.state, "binding_verified");
  assert.deepEqual(report.projects.map(project => project.id),
    ["paige-agent-ai", "ask-paige", "paige-intelligence", "paige-maps", "paige-folio", "paige-secure"]);
  assert.deepEqual(report.projects[0], { id: "paige-agent-ai", name: "PAIGE Agent AI", state: "matching" });
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
    return JSON.stringify({ legacyProjects: [], projects: JSON.parse(products).map(product => ({ ...product, state: "assumed" })) });
  } }), /Unexpected corporate project readback/);
});

test("surfaces the superseded PAIGE Cloud project without changing it", async () => {
  const legacyProjects = [{ id: "paige-cloud", name: "PAIGE Cloud" }];
  const report = await checkCorporateRegistry({ ...binding, async execute(sql, params) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|registry_create_project)\b/i);
    return JSON.stringify({ legacyProjects, projects: JSON.parse(params.products).map(product => ({
      ...product, state: "matching",
    })) });
  } });
  assert.deepEqual(report.legacyProjects, legacyProjects);
  const cli = fileURLToPath(new URL("./corporate-registry-preflight.mjs", import.meta.url));
  assert.equal(spawnSync(process.execPath, [cli, "--register"], { encoding: "utf8" }).status, 1);
});
