import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ownerId } from "./projects.mjs";

const derive = promisify(scrypt);
const scryptOptions = { N: 2 ** 15, r: 8, p: 3, maxmem: 40 * 1024 * 1024 };
const dummySalt = randomBytes(16);
const dummyDigest = randomBytes(32);
const applicationId = 0x50474341;
const invitationLifetime = 48 * 60 * 60 * 1000;
const invitationDigest = (code) => createHash("sha256").update(code).digest();

export function validCode(code) {
  return typeof code === "string" && /^[A-Za-z0-9_-]{43}$/.test(code);
}

export function normalizeEmail(value) {
  const email = value?.trim().toLowerCase() ?? "";
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)
    ? email : null;
}

export function validPassword(password) {
  return typeof password === "string" && [...password].length >= 15 && Buffer.byteLength(password) <= 512;
}

export function accountPath(membershipPath) {
  if (!isAbsolute(membershipPath ?? "")) throw new Error("An absolute Cloud membership path is required.");
  return join(dirname(membershipPath), "accounts.sqlite");
}

function checkFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("An absolute Cloud accounts path is required.");
  const file = lstatSync(path);
  if (!file.isFile() || (process.platform !== "win32" && (file.mode & 0o077) !== 0)) {
    throw new Error("Cloud accounts must be stored in a private regular file.");
  }
}

export function initializeAccounts(path) {
  if (!isAbsolute(path)) throw new Error("An absolute Cloud accounts path is required.");
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  checkFile(path);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 500; BEGIN IMMEDIATE;");
    const marker = db.prepare("PRAGMA application_id").get().application_id;
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const tables = db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1");
    if (marker === 0 && version === 0 && !tables.get()) {
      db.exec(`
        CREATE TABLE accounts (
          principal_id TEXT PRIMARY KEY NOT NULL,
          email TEXT UNIQUE NOT NULL,
          salt BLOB NOT NULL CHECK (length(salt) = 16),
          digest BLOB NOT NULL CHECK (length(digest) = 32)
        ) STRICT;
        CREATE TABLE invitations (
          email TEXT PRIMARY KEY NOT NULL,
          digest BLOB NOT NULL CHECK (length(digest) = 32),
          expires_at INTEGER NOT NULL
        ) STRICT;
        PRAGMA application_id = ${applicationId};
        PRAGMA user_version = 1;
      `);
    } else if (marker !== applicationId || version !== 1) {
      throw new Error("Unrecognized Cloud accounts database.");
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  openAccounts(path).close();
}

export function openAccounts(path, membershipPath) {
  checkFile(path);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 500");
    if (db.prepare("PRAGMA application_id").get().application_id !== applicationId ||
        db.prepare("PRAGMA user_version").get().user_version !== 1) {
      throw new Error("Unrecognized Cloud accounts database.");
    }
    const lookup = db.prepare("SELECT principal_id, salt, digest FROM accounts WHERE email = ?");
    // Keep the original credential schema readable by the previous console image.
    db.exec(`CREATE TABLE IF NOT EXISTS account_numbers (
      principal_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(principal_id),
      number TEXT UNIQUE NOT NULL CHECK (length(number) = 12 AND number NOT GLOB '*[^0-9]*')
    ) STRICT`);
    const numberLookup = db.prepare("SELECT number FROM account_numbers WHERE principal_id = ?");
    const principalExists = db.prepare("SELECT 1 FROM accounts WHERE principal_id = ?");
    const missingNumbers = db.prepare(`SELECT principal_id FROM accounts
      WHERE principal_id NOT IN (SELECT principal_id FROM account_numbers)`);
    const addNumber = db.prepare("INSERT INTO account_numbers VALUES (?, ?) ON CONFLICT(number) DO NOTHING");
    function assignNumber(principal) {
      for (let attempt = 0; attempt < 16; attempt++) {
        const number = String(randomInt(100_000_000_000, 1_000_000_000_000));
        if (addNumber.run(principal, number).changes === 1) return;
      }
      throw new Error("Could not assign a Cloud account number.");
    }
    function inTransaction(run) {
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
    inTransaction(() => {
      for (const { principal_id } of missingNumbers.all()) assignNumber(principal_id);
    });
    const accountEmail = db.prepare("SELECT email FROM accounts WHERE principal_id = ?");
    const hasOwner = db.prepare("SELECT 1 FROM accounts WHERE principal_id = ?");
    const invitation = db.prepare("SELECT 1 FROM invitations WHERE email = ? AND digest = ? AND expires_at > ?");
    let projectInvitation;
    if (membershipPath) {
      if (accountPath(membershipPath) !== path || membershipPath === path) throw new Error("Invalid Cloud membership path.");
      db.prepare("ATTACH DATABASE ? AS project_store").run(membershipPath);
      if (["main", "project_store"].some((schema) => db.prepare(`PRAGMA ${schema}.journal_mode`).get().journal_mode === "wal")) {
        throw new Error("Project invitations require the rollback journal.");
      }
      projectInvitation = db.prepare(`SELECT 1 FROM project_store.project_invitations i
        LEFT JOIN project_store.project_details d USING (organization_id, project_id)
        WHERE i.email = ? AND i.digest = ? AND i.expires_at > ? AND COALESCE(d.archived, 0) = 0`);
    }
    const removeInvitation = db.prepare("DELETE FROM invitations WHERE email = ?");
    const addOwner = db.prepare(`
      INSERT INTO accounts VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
    `);
    const addMember = db.prepare(`
      INSERT INTO accounts
      SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM accounts WHERE principal_id = ?)
      ON CONFLICT DO NOTHING
    `);
    return {
      hasOwner: () => !!hasOwner.get(ownerId),
      isOwnerEmail: (email) => lookup.get(email)?.principal_id === ownerId,
      emailFor: (principal) => accountEmail.get(principal)?.email,
      numberFor: (principal) => numberLookup.get(principal)?.number,
      ensureNumberFor(principal) {
        return numberLookup.get(principal)?.number ?? inTransaction(() => {
          if (!principalExists.get(principal)) return undefined;
          if (!numberLookup.get(principal)) assignNumber(principal);
          return numberLookup.get(principal).number;
        });
      },
      issueInvitation(email) {
        if (!hasOwner.get(ownerId)) throw new Error("Complete owner setup before issuing an invitation.");
        if (lookup.get(email)) throw new Error("An account already exists for this email.");
        const code = randomBytes(32).toString("base64url");
        db.prepare("DELETE FROM invitations WHERE expires_at <= ?").run(Date.now());
        db.prepare(`
          INSERT INTO invitations VALUES (?, ?, ?)
          ON CONFLICT (email) DO UPDATE SET digest = excluded.digest, expires_at = excluded.expires_at
        `).run(email, invitationDigest(code), Date.now() + invitationLifetime);
        return code;
      },
      hasInvitation: (email, code) => !!invitation.get(email, invitationDigest(code), Date.now()),
      async create(email, password, { owner = false, code, allowProjectSignup } = {}) {
        const salt = randomBytes(16);
        const digest = await derive(password, salt, 32, scryptOptions);
        const id = owner ? ownerId : "member-" + randomBytes(16).toString("hex");
        return inTransaction(() => {
          let added;
          if (owner) {
            added = addOwner.run(id, email, salt, digest).changes === 1;
          } else {
            const hashedCode = invitationDigest(code);
            const now = Date.now();
            const existing = invitation.get(email, hashedCode, now);
            const project = allowProjectSignup && projectInvitation?.get(email, hashedCode, now);
            added = (!!existing || !!project) && addMember.run(id, email, salt, digest, ownerId).changes === 1;
            if (added && existing) removeInvitation.run(email);
          }
          if (added) assignNumber(id);
          return added;
        });
      },
      async verify(email, password) {
        const account = lookup.get(email);
        const digest = await derive(password, account?.salt ?? dummySalt, 32, scryptOptions);
        return timingSafeEqual(digest, account?.digest ?? dummyDigest) ? account?.principal_id : undefined;
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [action, address, ...extra] = process.argv.slice(2);
  const path = accountPath(process.env.OWNER_VIEW_MEMBERSHIP_DB);
  if (action === "init" && address === undefined) {
    initializeAccounts(path);
    console.log("Cloud accounts database is ready.");
  } else if (action === "invite" && normalizeEmail(address) && !extra.length) {
    const accounts = openAccounts(path);
    try {
      console.log(accounts.issueInvitation(normalizeEmail(address)));
    } finally {
      accounts.close();
    }
  } else {
    throw new Error("Use accounts.mjs init or accounts.mjs invite <email>.");
  }
}
