// Operator-only readback. The account Lambda package does not include this module.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const company = "PAIGE Cloud";
const productProjects = [
  ["paige-agent-ai", "PAIGE Agent AI"],
  ["ask-paige", "Ask PAIGE"],
  ["paige-intelligence", "PAIGE Intelligence"],
  ["paige-maps", "PAIGE Maps"],
  ["paige-folio", "PAIGE Folio"],
  ["paige-secure", "PAIGE Secure"],
].map(([id, name]) => ({ id, name }));
const supersededIds = ["paige-cloud", "paige-drive", "presentation-room"];
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
        AND legacy.id IN (SELECT jsonb_array_elements_text(CAST(:superseded AS jsonb)))),
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
  const row = await execute(query, { ...bound, company, products: JSON.stringify(productProjects), superseded: JSON.stringify(supersededIds) });
  if (row == null) return { state: "binding_unverified" };
  const { projects: records, legacyProjects } = JSON.parse(row);
  if (!Array.isArray(records) || records.length !== productProjects.length || !Array.isArray(legacyProjects) ||
      legacyProjects.some(record => !supersededIds.includes(record?.id) ||
        typeof record.name !== "string")) throw new Error("Unexpected corporate registry readback");
  const observed = new Map(records.map(record => [record.id, record]));
  const projects = productProjects.map(({ id, name }) => {
    const record = observed.get(id);
    if (record?.name !== name || !statuses.has(record.state)) throw new Error("Unexpected corporate project readback");
    return { id, name, state: record.state };
  });
  return { state: "binding_verified", projects, legacyProjects: legacyProjects.map(({ id, name }) => ({ id, name })) };
}

async function run() {
  if (process.argv.length !== 2) throw new Error("This command only reads the corporate registry");
  const { CLOUD_DB_CLUSTER_ARN: resourceArn, CLOUD_DB_ADMIN_SECRET_ARN: secretArn,
    CLOUD_CORPORATE_ORG_ID: organization, CLOUD_CORPORATE_OWNER_ID: owner } = process.env;
  const cluster = /^arn:aws:rds:([a-z0-9-]+):(\d{12}):cluster:[a-zA-Z0-9-]+$/.exec(resourceArn ?? "");
  if (!cluster || !secretArn?.startsWith(`arn:aws:secretsmanager:${cluster[1]}:${cluster[2]}:secret:`)) {
    throw new Error("An existing same-account and same-region operator database connection is required");
  }
  const bound = requireBinding(organization, owner);
  const { ExecuteStatementCommand, RDSDataClient } = await import("@aws-sdk/client-rds-data");
  const client = new RDSDataClient({ region: cluster[1], maxAttempts: 1 });
  const connection = { resourceArn, secretArn, database: "paige_cloud" };
  const execute = async (sql, params) => {
    const parameters = Object.entries(params).map(([name, stringValue]) => ({ name, value: { stringValue } }));
    const result = await client.send(new ExecuteStatementCommand({ ...connection, sql, parameters }), {
      abortSignal: AbortSignal.timeout(8_000)
    });
    return result.records?.[0]?.[0]?.stringValue;
  };
  const report = await checkCorporateRegistry({ ...bound, execute });
  console.log(JSON.stringify(report));
  if (report.state !== "binding_verified" || report.legacyProjects.length ||
      report.projects.some(project => project.state !== "matching")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(() => {
    console.error("Corporate registry outcome could not be verified. Use the read-only preflight before retrying.");
    process.exitCode = 1;
  });
}
