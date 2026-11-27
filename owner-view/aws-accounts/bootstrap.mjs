// Operator-only migration entry point. Do not package this module in the Lambda ZIP.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RDSDataClient, RollbackTransactionCommand } from "@aws-sdk/client-rds-data";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export async function applyAccountMigration(raw, execute, readRuntimeCredential) {
  const migration = raw.trim().match(/^BEGIN;([\s\S]+)COMMIT;$/)?.[1];
  if (!migration || migration.includes("$cloud_ddl$")) throw new Error("Unexpected migration boundary");
  const hash = createHash("sha256").update(raw.replaceAll("\r\n", "\n")).digest("hex");
  await execute("DO $cloud_lock$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('paige-cloud-account-migration', 0)); END $cloud_lock$");
  await execute("CREATE SCHEMA IF NOT EXISTS cloud_account_migrations");
  await execute("REVOKE ALL ON SCHEMA cloud_account_migrations FROM PUBLIC");
  await execute("CREATE TABLE IF NOT EXISTS cloud_account_migrations.applied (version text PRIMARY KEY, checksum text NOT NULL)");
  const existing = await execute("SELECT checksum FROM cloud_account_migrations.applied WHERE version = '001'");
  if (existing) {
    if (existing !== hash) throw new Error("Applied account migration differs from reviewed source");
    return false;
  }

  const { username, password } = await readRuntimeCredential();
  if (username !== "paige_cloud_app" || typeof password !== "string" || password.length < 32) {
    throw new Error("Application database credential does not match its provisioned role");
  }
  await execute("CREATE ROLE paige_cloud_account_runtime NOLOGIN");
  await execute("SELECT length(set_config('paige_cloud.bootstrap_password', :password, true))", { password });
  await execute(`DO $cloud_role$ BEGIN
    EXECUTE format('CREATE ROLE paige_cloud_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD %L',
      current_setting('paige_cloud.bootstrap_password'));
    GRANT paige_cloud_account_runtime TO paige_cloud_app;
    GRANT CONNECT ON DATABASE paige_cloud TO paige_cloud_app;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Application database login setup failed';
  END $cloud_role$`);
  await execute(`DO $cloud_ddl$ BEGIN ${migration} END $cloud_ddl$`);
  await execute("INSERT INTO cloud_account_migrations.applied (version, checksum) VALUES ('001', :checksum)", { checksum: hash });
  return true;
}

async function bootstrap() {
  const {
    CLOUD_DB_CLUSTER_ARN: resourceArn, CLOUD_DB_ADMIN_SECRET_ARN: secretArn,
    CLOUD_DB_RUNTIME_SECRET_ARN: runtimeSecretArn
  } = process.env;
  if (!resourceArn || !secretArn || !runtimeSecretArn || secretArn === runtimeSecretArn) {
    throw new Error("Separate operator and application database credentials are required");
  }
  const raw = await readFile(new URL("../sql/cloud-accounts/001-accounts.sql", import.meta.url), "utf8");
  const connection = { resourceArn, secretArn, database: "paige_cloud" };
  const data = new RDSDataClient({});
  const { transactionId } = await data.send(new BeginTransactionCommand(connection));
  if (!transactionId) throw new Error("Database migration transaction was not created");
  const transaction = { ...connection, transactionId };

  async function execute(sql, params = {}) {
    const parameters = Object.entries(params).map(([name, value]) => ({ name, value: { stringValue: value } }));
    const response = await data.send(new ExecuteStatementCommand({ ...transaction, sql, parameters }));
    return response.records?.[0]?.[0]?.stringValue;
  }

  let applied;
  try {
    applied = await applyAccountMigration(raw, execute, async () => {
      const secrets = new SecretsManagerClient({});
      const secret = await secrets.send(new GetSecretValueCommand({ SecretId: runtimeSecretArn }));
      return JSON.parse(secret.SecretString ?? "{}");
    });
    await data.send(new CommitTransactionCommand(transaction));
  } catch (error) {
    try {
      await data.send(new RollbackTransactionCommand(transaction));
    } catch {
      // A lost commit response is reconciled by re-reading the recorded checksum on retry.
    }
    throw error;
  }

  const check = await data.send(new ExecuteStatementCommand({
    ...connection, secretArn: runtimeSecretArn,
    sql: `SELECT current_user = 'paige_cloud_app'
      AND has_function_privilege(current_user, 'cloud_accounts.account_details(uuid)', 'EXECUTE')
      AND NOT has_table_privilege(current_user, 'cloud_accounts.accounts', 'SELECT, INSERT, UPDATE, DELETE')`
  }));
  if (check.records?.[0]?.[0]?.booleanValue !== true) throw new Error("Application database login was not confirmed");
  console.log(applied ? "Cloud accounts migration and application login confirmed" : "Existing migration and application login confirmed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  bootstrap().catch(() => {
    console.error("Cloud account database readiness was not confirmed. Check the migration ledger and application credential.");
    process.exitCode = 1;
  });
}
