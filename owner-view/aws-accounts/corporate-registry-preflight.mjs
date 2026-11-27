// Operator-only readback. The account Lambda package does not include this module.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const company = "PAIGE Agent AI Inc.";
const productProjects = [
  ["paige-cloud", "PAIGE Cloud"],
  ["paige-agent-ai", "PAIGE Agent AI SaaS"],
  ["ask-paige", "Ask PAIGE"],
  ["paige-intelligence", "PAIGE Intelligence"],
  ["paige-maps", "PAIGE Maps"],
  ["paige-folio", "PAIGE Folio"],
  ["paige-secure", "PAIGE Secure"],
].map(([id, name]) => ({ id, name }));
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const statuses = new Set(["matching", "missing", "conflict"]);

const query = `
  WITH approved_organization AS (
    SELECT organization.id
      FROM cloud_accounts.organizations organization
      JOIN cloud_accounts.memberships membership ON membership.organization_id = organization.id
     WHERE organization.id = CAST(:organization AS uuid) AND organization.name = :company
       AND membership.account_id = CAST(:owner AS uuid)
       AND membership.role = 'owner' AND membership.revoked_at IS NULL
  ),
  desired_projects AS (
    SELECT * FROM jsonb_to_recordset(CAST(:products AS jsonb)) AS desired(id text, name text)
  )
  SELECT CAST(jsonb_build_object(
    'legacyProjects', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', legacy.id, 'name', legacy.name)
      ORDER BY legacy.id), '[]'::jsonb) FROM cloud_accounts.registry_projects legacy
      WHERE legacy.organization_id = organization.id
        AND legacy.id IN ('paige-drive', 'presentation-room')),
    'projects', jsonb_agg(jsonb_build_object(
    'id', desired.id, 'name', desired.name, 'state',
    CASE WHEN project.id IS NULL THEN 'missing'
         WHEN project.name = desired.name AND grant_entry.role = 'owner' THEN 'matching'
         ELSE 'conflict' END
  ) ORDER BY desired.id)) AS text)
  FROM approved_organization organization
  CROSS JOIN desired_projects desired
  LEFT JOIN cloud_accounts.registry_projects project
    ON project.organization_id = organization.id AND project.id = desired.id
  LEFT JOIN cloud_accounts.registry_grants grant_entry
    ON grant_entry.organization_id = project.organization_id AND grant_entry.project_id = project.id
    AND grant_entry.account_id = CAST(:owner AS uuid)
  GROUP BY organization.id`;

function requireBinding(organization, owner) {
  if (typeof organization !== "string" || !uuid.test(organization) ||
      typeof owner !== "string" || !uuid.test(owner)) throw new Error("Exact corporate organization and named owner IDs are required");
  return { organization, owner };
}

export async function checkCorporateRegistry({ organization, owner, execute }) {
  const bound = requireBinding(organization, owner);
  const row = await execute(query, { ...bound, company, products: JSON.stringify(productProjects) });
  if (row == null) return { state: "binding_unverified" };
  const { projects: records, legacyProjects } = JSON.parse(row);
  if (!Array.isArray(records) || records.length !== productProjects.length || !Array.isArray(legacyProjects) ||
      legacyProjects.some(record => !["paige-drive", "presentation-room"].includes(record?.id) ||
        typeof record.name !== "string")) throw new Error("Unexpected corporate registry readback");
  const observed = new Map(records.map(record => [record.id, record]));
  const projects = productProjects.map(({ id, name }) => {
    const record = observed.get(id);
    if (record?.name !== name || !statuses.has(record.state)) throw new Error("Unexpected corporate project readback");
    return { id, name, state: record.state };
  });
  return { state: "binding_verified", projects, legacyProjects: legacyProjects.map(({ id, name }) => ({ id, name })) };
}

// The supplied execute function must hold one transaction for the whole import. The
// normal registry writer locks membership before organization, so use that order here.
export async function registerCorporateProjects({ organization, owner, execute }) {
  const bound = requireBinding(organization, owner);
  const member = await execute(`
    SELECT 'owner' FROM cloud_accounts.memberships
    WHERE organization_id = CAST(:organization AS uuid) AND account_id = CAST(:owner AS uuid)
      AND role = 'owner' AND revoked_at IS NULL
    FOR SHARE`, bound);
  if (member !== "owner") return { state: "binding_unverified" };
  const target = await execute(`
    SELECT 'corporate' FROM cloud_accounts.organizations
    WHERE id = CAST(:organization AS uuid) AND name = :company
    FOR UPDATE`, { organization, company });
  if (target !== "corporate") return { state: "binding_unverified" };

  const required = await checkCorporateRegistry({ ...bound, execute });
  if (required.state !== "binding_verified") return required;
  if (required.legacyProjects.length || required.projects.some(project => project.state === "conflict")) {
    return { ...required, state: "conflict" };
  }
  if (!required.projects.some(project => project.state === "matching")) {
    return { ...required, state: "owner_project_required" };
  }

  let additions = 0;
  for (const project of required.projects) {
    if (project.state !== "missing") continue;
    const row = await execute(`
      SELECT CAST(cloud_accounts.registry_create_project(
        CAST(:owner AS uuid), CAST(:organization AS uuid), :project, :name
      ) AS text)`, { ...bound, project: project.id, name: project.name });
    const result = row == null ? null : JSON.parse(row);
    if (result?.id !== project.id || result.name !== project.name || result.role !== "owner") {
      throw new Error("Corporate metadata import did not return the expected project");
    }
    additions++;
  }
  const result = await checkCorporateRegistry({ ...bound, execute });
  if (result.state !== "binding_verified" || result.projects.some(project => project.state !== "matching")) {
    throw new Error("Corporate metadata import could not be verified before commit");
  }
  return { state: "import_verified", additions, projects: result.projects };
}

async function run() {
  const args = process.argv.slice(2);
  const register = args.length === 1 && args[0] === "--register";
  if (args.length && !register) throw new Error("Expected no arguments or --register");
  const { CLOUD_DB_CLUSTER_ARN: resourceArn, CLOUD_DB_ADMIN_SECRET_ARN: secretArn,
    CLOUD_CORPORATE_ORG_ID: organization, CLOUD_CORPORATE_OWNER_ID: owner } = process.env;
  const cluster = /^arn:aws:rds:([a-z0-9-]+):(\d{12}):cluster:[a-zA-Z0-9-]+$/.exec(resourceArn ?? "");
  if (!cluster || !secretArn?.startsWith(`arn:aws:secretsmanager:${cluster[1]}:${cluster[2]}:secret:`)) {
    throw new Error("An existing same-account and same-region operator database connection is required");
  }
  const bound = requireBinding(organization, owner);
  const { ExecuteStatementCommand, RDSDataClient, BeginTransactionCommand, CommitTransactionCommand,
    RollbackTransactionCommand } = await import("@aws-sdk/client-rds-data");
  const client = new RDSDataClient({ region: cluster[1], maxAttempts: 1 });
  const connection = { resourceArn, secretArn, database: "paige_cloud" };
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(8_000) });
  const executor = transactionId => async (sql, params) => {
    const parameters = Object.entries(params).map(([name, stringValue]) => ({ name, value: { stringValue } }));
    const result = await send(new ExecuteStatementCommand({ ...connection, transactionId, sql, parameters }));
    return result.records?.[0]?.[0]?.stringValue;
  };
  let report;
  if (register) {
    const { transactionId } = await send(new BeginTransactionCommand(connection));
    if (!transactionId) throw new Error("Corporate import transaction was not created");
    const transaction = { resourceArn, secretArn, transactionId };
    try {
      report = await registerCorporateProjects({ ...bound, execute: executor(transactionId) });
      if (report.state === "import_verified") await send(new CommitTransactionCommand(transaction));
      else await send(new RollbackTransactionCommand(transaction));
    } catch (error) {
      // A lost commit response is resolved by a new read-only preflight before retry.
      try { await send(new RollbackTransactionCommand(transaction)); } catch {}
      throw error;
    }
  } else {
    report = await checkCorporateRegistry({ ...bound, execute: executor() });
  }
  console.log(JSON.stringify(report));
  if (report.state !== (register ? "import_verified" : "binding_verified")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(() => {
    console.error("Corporate registry outcome could not be verified. Use the read-only preflight before retrying.");
    process.exitCode = 1;
  });
}
