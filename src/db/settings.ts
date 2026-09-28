import * as check from './check';
import type { Db, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  name: null,
  pause: null,
  quiet: null,
  dailyCap: null,
  criticalBreaksQuiet: true,
};

/** Stored as one JSON value per key, so adding a setting never needs a migration. */
export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings', []);
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) (out as unknown as Record<string, unknown>)[key] = JSON.parse(value);
  }
  return out;
}

export async function updateSettings(db: Db, patch: Partial<Settings>): Promise<Settings> {
  if (patch.quiet) check.quiet(patch.quiet);
  if (patch.dailyCap != null) check.positiveInt(patch.dailyCap, 'dailyCap', 100);
  if (patch.name != null) patch = { ...patch, name: patch.name.trim() || null };
  await db.withTransactionAsync(async () => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      await db.runAsync(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(value)],
      );
    }
  });
  return getSettings(db);
}

/** Pause everything is on at `now` (clears itself once `until` has passed). */
export function isPausedAll(s: Settings, now: number = Date.now()): boolean {
  return s.pause !== null && (s.pause.until === null || s.pause.until > now);
}
