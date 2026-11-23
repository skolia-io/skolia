// The API Worker's cron triggers. api/wrangler.jsonc's triggers.crons lists the same, in the same
// order (schema.workerd.test.ts checks), and scheduled() (main.ts) switches over them.

/** Every minute: the background migrations. 03:00 UTC: OPTIMIZE on D1, as SQLite advises a
 * long-lived connection, as D1's is, to run PRAGMA optimize periodically, "perhaps once per day". */
export const CRONS = ["* * * * *", "0 3 * * *"] as const;

export type Cron = (typeof CRONS)[number];

export function isCron(cron: string): cron is Cron {
  return (CRONS as readonly string[]).includes(cron);
}
