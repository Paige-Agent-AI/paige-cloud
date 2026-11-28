import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const eventId = /^[a-f0-9]{32}$/;
export const sessionMillis = 30 * 60 * 1000;
const startMillis = 15 * 60 * 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function openStreamEvents(filename, clock = Date.now) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS solo_events (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      request_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      token_hash TEXT,
      starts_by INTEGER,
      publisher TEXT,
      stops_by INTEGER,
      closed_at INTEGER,
      UNIQUE(workspace, request_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS solo_events_workspace_date ON solo_events(workspace, created_at DESC, id);
  `);
  const find = db.prepare("SELECT * FROM solo_events WHERE workspace = ? AND id = ?");
  const replay = db.prepare("SELECT * FROM solo_events WHERE workspace = ? AND request_id = ?");
  const list = db.prepare("SELECT * FROM solo_events WHERE workspace = ? ORDER BY created_at DESC, id LIMIT 100");
  const count = db.prepare("SELECT COUNT(*) AS count FROM solo_events WHERE workspace = ?");
  const insert = db.prepare("INSERT INTO solo_events (id, workspace, request_id, title, created_at) VALUES (?, ?, ?, ?, ?)");
  const rotate = db.prepare(`
    UPDATE solo_events SET token_hash = ?, starts_by = ?
    WHERE workspace = ? AND id = ? AND publisher IS NULL AND closed_at IS NULL
  `);
  const close = db.prepare(`
    UPDATE solo_events SET closed_at = COALESCE(closed_at, ?), token_hash = NULL, starts_by = NULL
    WHERE workspace = ? AND id = ?
  `);
  const admit = db.prepare(`
    UPDATE solo_events SET publisher = ?, stops_by = COALESCE(stops_by, ?)
    WHERE id = ? AND closed_at IS NULL AND token_hash = ?
      AND ((publisher IS NULL AND starts_by > ?) OR (publisher = ? AND stops_by > ?))
      AND NOT EXISTS (
        SELECT 1 FROM solo_events x WHERE x.workspace = solo_events.workspace AND x.id <> solo_events.id
          AND x.closed_at IS NULL AND x.stops_by > ?
      )
      AND (SELECT COUNT(*) FROM solo_events x WHERE x.id <> solo_events.id
        AND x.closed_at IS NULL AND x.stops_by > ?) < 2
    RETURNING stops_by
  `);
  return {
    list: (workspace) => list.all(workspace),
    get: (workspace, id) => find.get(workspace, id),
    create(workspace, requestId, title) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = replay.get(workspace, requestId);
        let result;
        if (existing) result = existing.title === title ? { event: existing, created: false } : { error: "idempotency_conflict" };
        else if (count.get(workspace).count >= 100) result = { error: "workspace_event_limit" };
        else {
          const id = randomUUID().replaceAll("-", "");
          insert.run(id, workspace, requestId, title, clock());
          result = { event: find.get(workspace, id), created: true };
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    encoder(workspace, id) {
      const password = randomBytes(32).toString("hex");
      const expires = clock() + startMillis;
      if (!rotate.run(hash(password), expires, workspace, id).changes) return null;
      return { password, expires };
    },
    admit(id, connection, password) {
      const now = clock();
      return admit.get(connection, now + sessionMillis, id, hash(password), now, connection, now, now, now)?.stops_by;
    },
    close(workspace, id) {
      close.run(clock(), workspace, id);
    },
    dispose: () => db.close(),
  };
}
