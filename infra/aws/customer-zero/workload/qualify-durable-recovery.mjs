import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";

// Developer qualification against a disposable, loopback PostgreSQL database. This
// script has no cloud credentials, provider adapter, approval writer or Rail writer.
const revision = "79e2f303e41662af2a8e7c3027ec4189127727d5";
const shared = "functions/_shared";
const pinned = {
  risk: [`${shared}/action-risk.ts`, "942b4a296b281e7474e5fee416d11ffaa3f3e9b03f182c3d62b3dc247f32483d"],
  spine: [`${shared}/paige-spine/governedExecution.ts`, "ba5362d01e7aa35bac6ee6b2fe9d88f991e79149e5ff9bdd0de913206df75b59"],
  work: [`${shared}/durable-job/mod.ts`, "3161bba369221be68b68cb6bc69636922494fdfa2da9559f75a7a203a7c3841b"],
  dispatch: [`${shared}/paige-orchestration/dispatch-claim.ts`, "14ca0bfd6d2839d4ea32034f4fe61d0d454ef7cd2655f9dbad25ad2b62f129c7"],
  trajectory: [`${shared}/trajectory/contract.ts`, "fa035ef9809fae0db6dfdb193715e5af7565c4414ab8eb8388b28d8c25b9d1cf"],
  eval: [`${shared}/eval/trajectory-registry.ts`, "bb84db8c0c04aace17618fcddfb98a76ff99b00d22f4e9ec9ad7f59a3202c398"],
  envelope: ["migrations/20270417000000_paige_durable_work_envelope.sql", "1c668ee7fb865cb53c1f684f0ca2a33144941d09fac4a598bde836163a49e683"],
  claim: ["migrations/20271025000100_paige_dispatch_crash_recovery.sql", "e6a44011351425590930e26adcd1f5500f5cb4bc9acd3938f5112d1bba820bbf"]
};

const [, , originalRepo, psql, port, database] = process.argv;
if (!originalRepo || !psql || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 ||
    !/^paige_recovery_qualification_[a-z0-9]+$/.test(database)) {
  throw new Error("Supply the original PAIGE repo, psql path, port and a fresh local paige_recovery_qualification_* database");
}
const source = Object.fromEntries(Object.entries(pinned).map(([key, [path, digest]]) => {
  const bytes = execFileSync("git", ["-C", originalRepo, "show", `${revision}:supabase/${path}`]);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, path);
  return [key, bytes.toString("utf8")];
}));
function moduleUrl(ts) {
  const js = stripTypeScriptTypes(ts, { mode: "strip" });
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}
const { decideGovernedExecution } = await import(moduleUrl(source.spine.replace("../action-risk.ts", moduleUrl(source.risk))));
const { dispatchUnderClaim } = await import(moduleUrl(source.dispatch));
const { needsReconciliation, capabilityOutcomeFor } = await import(moduleUrl(source.work));
const { correlateTrajectory, classifyTrajectory } = await import(moduleUrl(source.trajectory));
const { evaluatorVerdict } = await import(moduleUrl(source.eval));

// Each call gets a new connection. The work record and dispatch lock must therefore
// survive disconnects. Clear inherited libpq options that can select another connection.
const localPg = { ...process.env };
for (const key of Object.keys(localPg)) {
  if (/^PG/i.test(key) && !["PGUSER", "PGPASSWORD", "PGPASSFILE"].includes(key.toUpperCase())) delete localPg[key];
}
localPg.PGCLIENTENCODING = "UTF8";
function sql(statement) {
  return new Promise((resolve, reject) => {
    const connection = execFile(psql, ["-XqAtw", "--set=ON_ERROR_STOP=1", "--host=127.0.0.1",
      `--port=${port}`, `--dbname=${database}`, "--file=-"], { env: localPg, timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout.trim());
      });
    connection.stdin.on("error", reject);
    connection.stdin.end(statement);
  });
}

const [tenant, otherTenant, actor, otherActor, intent, event, act] = Array.from({ length: 7 }, () => crypto.randomUUID());
const capabilityKey = "cloud_workload_rollback";
const decision = decideGovernedExecution({
  caller: { authenticated: true, userId: actor, principal: "person", tenantId: tenant,
    tenantSource: "server", door: "automation", access: { allowed: true } },
  capability: { id: capabilityKey, effect: "mutate", availability: "live", outcomeChannel: "rail" },
  approval: { autonomyLane: "confirm" },
  requestArgs: {}
});
assert.equal(decision.kind, "refuse");
assert.equal(decision.code, "unclassified_mutation");

// Test-only prerequisites, followed by the original Work SQL through its protected
// read seam and the original dispatch-claim function. Keep unrelated tables out.
await sql(`
begin;
do $$ begin
  if current_database() !~ '^paige_recovery_qualification_[a-z0-9]+$'
     or current_setting('server_version_num')::integer not between 160000 and 169999
     or exists (select from pg_database where not datistemplate and datname not in ('postgres', current_database()))
     or exists (select from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public')
     or exists (select from pg_namespace where nspname = 'auth') then
    raise exception 'A fresh qualification database on an otherwise empty, disposable PostgreSQL 16 cluster is required';
  end if;
end $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('qualification.actor', true), '')::uuid $$;
create function public.is_platform_owner() returns boolean language sql stable as $$ select false $$;
create table auth.users (id uuid primary key);
create table public.tenants (id uuid primary key, status text);
create table public.tenant_members (tenant_id uuid, user_id uuid, status text, is_owner boolean, role text);
create table public.paige_chat_threads (id uuid primary key, tenant_id uuid, caller_user_id uuid, is_archived boolean);
create table public.paige_act_executions (id uuid primary key, event_id uuid, act_id uuid, outcome text, detail jsonb);
${source.envelope.slice(0, source.envelope.indexOf("-- Existing capability-specific records"))}
${source.claim.slice(source.claim.indexOf("create function public.paige_claim_act_dispatch("),
    source.claim.indexOf("alter table public.paige_native_events"))}
insert into auth.users values ('${actor}'), ('${otherActor}');
insert into public.tenants values ('${tenant}', 'active'), ('${otherTenant}', 'active');
insert into public.tenant_members values
  ('${tenant}', '${actor}', 'active', true, 'owner'),
  ('${otherTenant}', '${otherActor}', 'active', true, 'owner');
insert into public.paige_act_executions values (gen_random_uuid(), '${event}', '${act}', 'accepted_for_execution', '{}');
commit;`);

const create = (organization, person, scopeEpoch = "private-evaluator-1") => sql(`
  set role service_role;
  select row_to_json(w) from public.create_paige_durable_work(
    '${organization}', '${person}', '${intent}', null, '${capabilityKey}', 'recovery_qualification',
    jsonb_build_object('tenant_id','${organization}','actor_user_id','${person}'),
    '${scopeEpoch}', 30, 1) w;`).then(JSON.parse);
const original = await create(tenant, actor);
const resumed = await create(tenant, actor);
assert.equal(original.resumed_existing, false);
assert.deepEqual(resumed, { ...original, resumed_existing: true });
await assert.rejects(create(tenant, actor, "changed-scope"), /DURABLE_WORK_INTENT_REPLAY_MISMATCH/);
const other = await create(otherTenant, otherActor);
assert.notEqual(other.work_id, original.work_id);
const readWork = (person, workId) => sql(`
  set role authenticated;
  set qualification.actor = '${person}';
  select row_to_json(w) from public.get_paige_durable_work('${workId}') w;`);
for (const [person, own, foreign] of [[actor, original, other], [otherActor, other, original]]) {
  const read = JSON.parse(await readWork(person, own.work_id));
  assert.equal(read.work_id, own.work_id);
  assert.equal(read.work_status, "claimed");
  assert.equal(Object.hasOwn(read, "authority_context"), false);
  assert.equal(Object.hasOwn(read, "server_idempotency_key"), false);
  assert.equal(await readWork(person, foreign.work_id), "");
}

let adapterInvocations = 0;
const rpc = {
  async rpc(name, args) {
    assert.equal(name, "paige_claim_act_dispatch");
    const id = await sql(`set role service_role; select (public.paige_claim_act_dispatch(
      '${args._event_id}', '${args._act_id}', '${args._claim}', '${args._stale_after}', ${args._allow_retake})).id;`);
    return { data: id ? { id } : null, error: null };
  }
};
const fixtureAdapter = {
  lostClaimRecovery: "never",
  async dispatch() {
    adapterInvocations++;
    throw new Error("Simulated loss of the provider result");
  }
};
const competing = await Promise.all(Array.from({ length: 4 }, () =>
  dispatchUnderClaim(rpc, event, act, fixtureAdapter, {})));
assert.equal(adapterInvocations, 1);
assert.equal(competing.filter(x => x.kind === "held").length, 3);
assert.equal(competing.find(x => x.kind === "dispatched").result.outcome, "ambiguous");
await sql(`update public.paige_act_executions set detail = detail ||
  jsonb_build_object('dispatch_claimed_at', now() - interval '11 minutes') where event_id = '${event}';`);
assert.equal((await dispatchUnderClaim(rpc, event, act, fixtureAdapter, {})).kind, "held");
assert.equal(adapterInvocations, 1);

const transition = (status, evidence = "null", reconciled = false) => sql(`
  set role service_role;
  select work_status from public.transition_paige_durable_work('${original.work_id}',
    '${original.server_idempotency_key}', '${status}', ${evidence}, null, null, null, 30, ${reconciled});`);
assert.equal(await transition("outcome_unknown"), "outcome_unknown");
assert.equal(needsReconciliation("outcome_unknown"), true);
assert.equal(needsReconciliation("expired"), true);
await assert.rejects(transition("claimed"), /DURABLE_WORK_RECONCILIATION_REQUIRED/);
await assert.rejects(transition("claimed", "null", true), /DURABLE_WORK_ATTEMPT_CEILING/);
await assert.rejects(transition("succeeded", "'{}'::jsonb", true), /DURABLE_WORK_SUCCESS_REQUIRES_READBACK/);

// Intelligence's acceptance contract exercised with synthetic receipt references.
// These are not Rail writes, actual provider facts or authority to set reconciled=true.
const identity = { version: 1, workId: original.work_id, tenantId: tenant, actorId: actor,
  threadId: null, intentId: intent, capabilityKey, category: "infrastructure" };
const evidence = { workId: original.work_id, tenantId: tenant, actorId: actor, threadId: null,
  source: "canonical", at: new Date().toISOString(), attempt: 1 };
const receipt = { ...evidence, kind: "receipt", id: "fixture-receipt", outcome: capabilityOutcomeFor("succeeded") };
const readback = { ...evidence, kind: "readback", id: "fixture-readback" };
const { events, rejected } = correlateTrajectory(identity, [receipt, { ...readback, tenantId: otherTenant }]);
assert.equal(rejected, 1);
assert.equal(classifyTrajectory("outcome_unknown", events, "artifact", 1), "reconciliation_required");
assert.equal(classifyTrajectory("succeeded", events, "artifact", 1), "terminal_unverified");
assert.equal(classifyTrajectory("succeeded", [...events, { ...readback, attempt: 2 }], "artifact", 1), "terminal_unverified");
const verified = classifyTrajectory("succeeded", [...events, readback], "artifact", 1);
assert.equal(verified, "artifact_verified");
assert.equal(evaluatorVerdict("applicable", "complete", verified === "artifact_verified" ? "met" : "not_met"), "pass");
console.log(JSON.stringify({ revision, environment: "local_disposable_postgresql", actualProviderEffects: 0,
  resumedAcrossConnections: true, reciprocalTenantDenial: true, competingClaimants: 4, adapterInvocations,
  lostClaimReplayDenied: true, unknownOutcomeReplayDenied: true, attemptCeilingEnforced: true,
  successWithoutReadbackDenied: true, intelligenceEvidenceContract: "pass_with_fixtures",
  cloudMutationAdmission: decision.code }));
