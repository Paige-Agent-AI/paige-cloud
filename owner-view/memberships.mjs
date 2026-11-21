import { closeSync, linkSync, lstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { firstProject, isProjectSlug, ownerId } from "./projects.mjs";

const applicationId = 0x5047434c;
const schemaVersion = 1;
const grantSql = `
  INSERT INTO project_memberships (principal_id, organization_id, project_id)
  VALUES (?, ?, ?) ON CONFLICT (principal_id, organization_id, project_id) DO NOTHING
`;

function requireAbsolutePath(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("OWNER_VIEW_MEMBERSHIP_DB must be an absolute database path.");
  }
}

function connect(path, readOnly) {
  requireAbsolutePath(path);
  const db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA busy_timeout = 500");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openMembershipStore(path) {
  const db = connect(path, true);
  try {
    checkSchema(db);
    const membership = db.prepare(`
      SELECT 1 FROM project_memberships
      WHERE principal_id = ? AND organization_id = ? AND project_id = ?
    `);
    return {
      hasProjectRead: (...scope) => membership.get(...scope) !== undefined,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function checkSchema(db) {
  if (db.prepare("PRAGMA application_id").get().application_id !== applicationId ||
      db.prepare("PRAGMA user_version").get().user_version !== schemaVersion) {
    throw new Error("Unrecognized Cloud membership database.");
  }
}

export function initializeMembershipStore(path) {
  requireAbsolutePath(path);
  try {
    lstatSync(path);
    openMembershipStore(path).close();
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stage = mkdtempSync(join(dirname(path), ".paige-memberships-"));
  const stagedPath = join(stage, "memberships.sqlite");
  try {
    closeSync(openSync(stagedPath, "wx", 0o600));
    seedMembershipStore(stagedPath);
    try {
      linkSync(stagedPath, path);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      openMembershipStore(path).close();
      return false;
    }
  } finally {
    try {
      unlinkSync(stagedPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    rmdirSync(stage);
  }
}

function seedMembershipStore(path) {
  const db = connect(path, false);
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE projects (
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        PRIMARY KEY (organization_id, project_id)
      ) STRICT;
      CREATE TABLE project_memberships (
        principal_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        PRIMARY KEY (principal_id, organization_id, project_id),
        FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
      ) STRICT;
      PRAGMA application_id = ${applicationId};
      PRAGMA user_version = ${schemaVersion};
    `);
    const { organizationId, projectId } = firstProject;
    db.prepare("INSERT INTO projects VALUES (?, ?)").run(organizationId, projectId);
    db.prepare(grantSql).run(ownerId, organizationId, projectId);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export function updateProjectMembership(path, action, principalId, organizationId, projectId) {
  if (!["grant", "revoke"].includes(action) || ![principalId, organizationId, projectId].every(isProjectSlug)) {
    throw new Error("Use grant or revoke with valid principal, organization, and project IDs.");
  }
  // Check the existing file without SQLite's writer mode creating it on a typo.
  openMembershipStore(path).close();
  const db = connect(path, false);
  try {
    checkSchema(db);
    const statement = action === "grant" ? grantSql : `
      DELETE FROM project_memberships
      WHERE principal_id = ? AND organization_id = ? AND project_id = ?
    `;
    return db.prepare(statement).run(principalId, organizationId, projectId).changes === 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [action, ...scope] = process.argv.slice(2);
  const path = process.env.OWNER_VIEW_MEMBERSHIP_DB;
  try {
    if (action === "init" && scope.length === 0) {
      console.log(initializeMembershipStore(path) ? "Membership database initialized." : "Membership database already initialized.");
    } else if (["grant", "revoke"].includes(action) && scope.length === 3) {
      console.log(updateProjectMembership(path, action, ...scope) ? "Membership updated." : "Membership already in requested state.");
    } else {
      throw new Error("Use init or grant/revoke <principal> <organization> <project>.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
