import type { Db } from './types';

/**
 * Append-only list of migrations; index + 1 is the schema version stored in
 * `PRAGMA user_version`. Never edit a shipped migration — add a new one.
 */
export const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE plan (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,
    start_date    TEXT    NOT NULL,
    days          INTEGER NULL CHECK (days IS NULL OR days > 0),
    tz            TEXT    NOT NULL,
    per_day       INTEGER NOT NULL CHECK (per_day > 0),
    quiet_start   TEXT    NOT NULL,
    quiet_end     TEXT    NOT NULL,
    weekend_start TEXT    NULL,
    status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
    paused_until  INTEGER NULL,
    quiet_until   INTEGER NULL,
    skipped_date  TEXT    NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE notif (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id       INTEGER NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
    key           TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    icon          TEXT    NOT NULL DEFAULT 'spark',
    at            TEXT    NULL,
    on_rule       TEXT    NOT NULL DEFAULT 'daily',
    messages_json TEXT    NOT NULL DEFAULT '[]',
    priority      TEXT    NOT NULL DEFAULT 'gentle' CHECK (priority IN ('silent', 'gentle', 'critical')),
    optional      INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0, 1)),
    on_miss       TEXT    NOT NULL DEFAULT 'none' CHECK (on_miss IN ('none', 'nudge_once')),
    enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    sort          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (plan_id, key),
    CHECK (enabled = 0 OR at IS NOT NULL)
  );
  CREATE INDEX notif_plan ON notif(plan_id, sort);

  CREATE TABLE occurrence (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    notif_id           INTEGER NOT NULL REFERENCES notif(id) ON DELETE CASCADE,
    fire_at            INTEGER NOT NULL,
    local_date         TEXT    NOT NULL,
    message_index      INTEGER NOT NULL DEFAULT 0,
    os_notification_id TEXT    NULL,
    state              TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'done', 'snoozed', 'skipped', 'missed')),
    acted_at           INTEGER NULL,
    UNIQUE (notif_id, fire_at)
  );
  CREATE INDEX occurrence_fire_at ON occurrence(fire_at);
  CREATE INDEX occurrence_local_date ON occurrence(local_date);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  /* 2 — snoozes are their own rows, linked to the occurrence they came from */ `
  ALTER TABLE occurrence ADD COLUMN kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'snooze'));
  ALTER TABLE occurrence ADD COLUMN parent_id INTEGER NULL REFERENCES occurrence(id) ON DELETE CASCADE;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Opens the connection for use: foreign keys on, WAL, then any pending migrations. */
export async function migrate(db: Db): Promise<number> {
  await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version', []);
  const from = row?.user_version ?? 0;
  if (from > SCHEMA_VERSION) {
    throw new Error(`Database is at schema v${from}, newer than this app (v${SCHEMA_VERSION}).`);
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(MIGRATIONS[v]!);
      await db.execAsync(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return SCHEMA_VERSION;
}
