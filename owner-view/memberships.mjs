import { createHash, randomBytes } from "node:crypto";
import { closeSync, linkSync, lstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { accountPath, openAccounts } from "./accounts.mjs";
import { firstProject, isProjectSlug, ownerId } from "./projects.mjs";

const applicationId = 0x5047434c;
const schemaVersion = 1;
const grantSql = `
  INSERT INTO project_memberships (principal_id, organization_id, project_id)
  VALUES (?, ?, ?) ON CONFLICT (principal_id, organization_id, project_id) DO NOTHING
`;
const removeGrantSql = "DELETE FROM project_memberships WHERE principal_id = ? AND organization_id = ? AND project_id = ?";
const removeInvitationSql = "DELETE FROM project_invitations WHERE organization_id = ? AND project_id = ? AND email = ?";

function transaction(db, run) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function revokeGrant(db, principal, organization, project, email) {
  return transaction(db, () => {
    const removed = db.prepare(removeGrantSql).run(principal, organization, project).changes === 1;
    if (email) db.prepare(removeInvitationSql).run(organization, project, email);
    return removed;
  });
}

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
    if (action === "grant") return db.prepare(grantSql).run(principalId, organizationId, projectId).changes === 1;
    const hasInvitations = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'project_invitations'").get();
    let email;
    if (hasInvitations) {
      const accounts = openAccounts(accountPath(path));
      try { email = accounts.emailFor(principalId); } finally { accounts.close(); }
    }
    return revokeGrant(db, principalId, organizationId, projectId, email);
  } finally {
    db.close();
  }
}

const invitationWindow = 48 * 60 * 60 * 1000;
const hashCode = (code) => createHash("sha256").update(code).digest();

export function openProjectCatalog(path) {
  openMembershipStore(path).close();
  const db = connect(path, false);
  try {
    // These additive tables leave the original project and grant schema usable by the prior console.
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS project_details (
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        PRIMARY KEY (organization_id, project_id),
        FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_environments (
        organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, name TEXT NOT NULL,
        PRIMARY KEY (organization_id, project_id, environment_id),
        FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_applications (
        organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
        application_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('application', 'service')),
        PRIMARY KEY (organization_id, project_id, environment_id, application_id),
        FOREIGN KEY (organization_id, project_id, environment_id)
          REFERENCES project_environments (organization_id, project_id, environment_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_invitations (
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        email TEXT NOT NULL,
        digest BLOB NOT NULL UNIQUE CHECK (length(digest) = 32),
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, project_id, email),
        FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_memberships_by_project
        ON project_memberships (organization_id, project_id);
      CREATE INDEX IF NOT EXISTS projects_by_project_id ON projects (project_id);
      CREATE TABLE IF NOT EXISTS customer_invitations (
        email TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        digest BLOB NOT NULL UNIQUE CHECK (length(digest) = 32),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_streams (
        id TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        live_input TEXT NOT NULL UNIQUE,
        video_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_streams_by_project
        ON project_streams (organization_id, project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS customer_organizations (
        organization_id TEXT PRIMARY KEY NOT NULL,
        customer_id TEXT UNIQUE NOT NULL,
        first_project_id TEXT NOT NULL,
        FOREIGN KEY (organization_id, first_project_id) REFERENCES projects (organization_id, project_id)
      ) STRICT;
    `);
    const { organizationId, projectId } = firstProject;
    db.prepare(`INSERT INTO project_details (organization_id, project_id, name)
      VALUES (?, ?, 'PAIGE Agent AI') ON CONFLICT DO NOTHING`).run(organizationId, projectId);
    db.exec("COMMIT");

    const fields = `p.organization_id AS organizationId, p.project_id AS projectId,
      COALESCE(d.name, p.project_id) AS name, COALESCE(d.archived, 0) AS archived`;
    const rows = `FROM projects p LEFT JOIN project_details d USING (organization_id, project_id)`;
    const byProject = db.prepare(`SELECT ${fields} ${rows} WHERE p.organization_id = ? AND p.project_id = ?`);
    const environments = db.prepare(`SELECT environment_id AS id, name FROM project_environments
      WHERE organization_id = ? AND project_id = ? ORDER BY environment_id`);
    const applications = db.prepare(`SELECT environment_id AS environmentId, application_id AS id, name, kind
      FROM project_applications WHERE organization_id = ? AND project_id = ? ORDER BY environment_id, application_id`);
    const addEnvironment = db.prepare(`INSERT INTO project_environments
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM project_environments
        WHERE organization_id = ? AND project_id = ?) < 50 ON CONFLICT DO NOTHING`);
    const addApplication = db.prepare(`INSERT INTO project_applications
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM project_environments
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?)
      AND (SELECT COUNT(*) FROM project_applications WHERE organization_id = ? AND project_id = ?) < 100
      ON CONFLICT DO NOTHING`);
    const allProjects = db.prepare(`SELECT ${fields} ${rows} ORDER BY archived, name, organizationId, projectId`);
    const memberProjects = db.prepare(`SELECT ${fields} ${rows}
      JOIN project_memberships m USING (organization_id, project_id)
      WHERE m.principal_id = ? AND COALESCE(d.archived, 0) = 0
      ORDER BY name, organizationId, projectId`);
    const access = db.prepare(`SELECT 1 FROM project_memberships m
      LEFT JOIN project_details d USING (organization_id, project_id)
      WHERE m.principal_id = ? AND m.organization_id = ? AND m.project_id = ? AND COALESCE(d.archived, 0) = 0`);
    const members = db.prepare(`SELECT principal_id AS id FROM project_memberships
      WHERE organization_id = ? AND project_id = ? ORDER BY principal_id`);
    const pending = db.prepare(`SELECT email, expires_at AS expiresAt FROM project_invitations
      WHERE organization_id = ? AND project_id = ? AND expires_at > ? ORDER BY email`);
    const invite = db.prepare(`SELECT i.organization_id AS organizationId, i.project_id AS projectId
      FROM project_invitations i LEFT JOIN project_details d USING (organization_id, project_id)
      WHERE i.email = ? AND i.digest = ? AND i.expires_at > ? AND COALESCE(d.archived, 0) = 0`);
    const grant = db.prepare(grantSql);
    const customerHome = db.prepare(`SELECT c.organization_id AS organizationId, c.first_project_id AS projectId
      FROM customer_organizations c
      JOIN project_memberships m ON m.principal_id = c.customer_id
        AND m.organization_id = c.organization_id AND m.project_id = c.first_project_id
      JOIN project_details d ON d.organization_id = c.organization_id AND d.project_id = c.first_project_id
      WHERE c.customer_id = ? AND d.archived = 0`);
    const customerInvitation = db.prepare(`SELECT 1 FROM customer_invitations
      WHERE email = ? AND digest = ? AND expires_at > ?`);
    const pendingCustomers = db.prepare(`SELECT email, name, expires_at AS expiresAt FROM customer_invitations
      WHERE expires_at > ? ORDER BY email`);
    const removeCustomerInvite = db.prepare("DELETE FROM customer_invitations WHERE email = ?");
    const invitesForProject = db.prepare("DELETE FROM project_invitations WHERE organization_id = ? AND project_id = ?");
    const removeInvite = db.prepare(removeInvitationSql);
    const projectStreams = db.prepare(`SELECT id, title, created_at AS createdAt FROM project_streams
      WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC, id LIMIT 100`);
    const projectStream = db.prepare(`SELECT id, title, live_input AS liveInput, video_id AS videoId, created_at AS createdAt FROM project_streams
      WHERE organization_id = ? AND project_id = ? AND id = ?`);
    const registerStream = db.prepare(`INSERT INTO project_streams (id, organization_id, project_id, title, live_input, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (live_input) DO NOTHING`);
    const find = (email, code) => invite.get(email, hashCode(code), Date.now());
    return {
      get: (scope) => byProject.get(scope.organizationId, scope.projectId),
      registrations(principal, { organizationId: org, projectId: id }) {
        return transaction(db, () => {
          const project = byProject.get(org, id);
          if (!project || project.archived || (principal !== ownerId && !access.get(principal, org, id))) return undefined;
          return { environments: environments.all(org, id), applications: applications.all(org, id) };
        });
      },
      register(principal, { organizationId: org, projectId: id }, entry) {
        if (principal !== ownerId) return "unavailable";
        return transaction(db, () => {
          const project = byProject.get(org, id);
          if (!project || project.archived) return "unavailable";
          if (entry.kind === "environment") return addEnvironment.run(org, id, entry.id, entry.name, org, id).changes ? "created" : "conflict";
          if (!["application", "service"].includes(entry.kind)) return "unavailable";
          return addApplication.run(org, id, entry.environmentId, entry.id, entry.name, entry.kind,
            org, id, entry.environmentId, org, id).changes ? "created" : "conflict";
        });
      },
      streams: (scope) => projectStreams.all(scope.organizationId, scope.projectId),
      stream: (scope, id) => projectStream.get(scope.organizationId, scope.projectId, id),
      pinStreamVideo(scope, id, video) {
        db.prepare(`UPDATE project_streams SET video_id = ? WHERE organization_id = ? AND project_id = ?
          AND id = ? AND video_id IS NULL`).run(video, scope.organizationId, scope.projectId, id);
        return projectStream.get(scope.organizationId, scope.projectId, id)?.videoId;
      },
      registerStream(scope, title, input) {
        const id = randomBytes(10).toString("hex");
        return registerStream.run(id, scope.organizationId, scope.projectId, title, input, Date.now()).changes ? id : undefined;
      },
      list: (principal) => principal === ownerId ? allProjects.all() : memberProjects.all(principal),
      hasProjectRead: (...keys) => !!access.get(...keys),
      members: (scope) => members.all(scope.organizationId, scope.projectId),
      pending: (scope) => pending.all(scope.organizationId, scope.projectId, Date.now()),
      customerHome: (principal) => customerHome.get(principal),
      pendingCustomers: () => pendingCustomers.all(Date.now()),
      hasCustomerInvitation: (email, code) => !!customerInvitation.get(email, hashCode(code), Date.now()),
      cancelCustomerInvitation: (email) => removeCustomerInvite.run(email),
      create(org, id, name) {
        return transaction(db, () => {
          if (!db.prepare("INSERT INTO projects VALUES (?, ?) ON CONFLICT DO NOTHING").run(org, id).changes) return false;
          db.prepare("INSERT INTO project_details (organization_id, project_id, name) VALUES (?, ?, ?)").run(org, id, name);
          grant.run(ownerId, org, id);
          return true;
        });
      },
      rename(org, id, name) {
        if (org === organizationId && id === projectId) return false;
        db.prepare(`INSERT INTO project_details (organization_id, project_id, name) VALUES (?, ?, ?)
          ON CONFLICT (organization_id, project_id) DO UPDATE SET name=excluded.name`).run(org, id, name);
        return true;
      },
      archive(org, id, archived) {
        if (org === organizationId && id === projectId) return false;
        return transaction(db, () => {
          db.prepare(`INSERT INTO project_details VALUES (?, ?, ?, ?)
            ON CONFLICT (organization_id, project_id) DO UPDATE SET archived=excluded.archived`).run(org, id, id, Number(archived));
          if (archived) invitesForProject.run(org, id);
          return true;
        });
      },
      issue(org, id, email) {
        return transaction(db, () => {
          const project = byProject.get(org, id);
          if (!project || project.archived) return undefined;
          const code = randomBytes(32).toString("base64url");
          db.prepare("DELETE FROM project_invitations WHERE expires_at <= ?").run(Date.now());
          db.prepare(`INSERT INTO project_invitations VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (organization_id, project_id, email) DO UPDATE SET digest=excluded.digest, expires_at=excluded.expires_at`)
            .run(org, id, email, hashCode(code), Date.now() + invitationWindow);
          return code;
        });
      },
      hasInvitation: (email, code) => !!find(email, code),
      accept(principal, email, code) {
        if (principal === ownerId) return undefined;
        return transaction(db, () => {
          const scope = find(email, code);
          if (!scope) return undefined;
          grant.run(principal, scope.organizationId, scope.projectId);
          removeInvite.run(scope.organizationId, scope.projectId, email);
          return scope;
        });
      },
      cancelInvite: (org, id, email) => removeInvite.run(org, id, email),
      revoke(org, id, principal, email) {
        if (principal === ownerId) return false;
        revokeGrant(db, principal, org, id, email);
        return true;
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
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
