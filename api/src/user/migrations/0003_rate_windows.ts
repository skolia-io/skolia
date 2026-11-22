import { iso } from "@skolia/util/checks";

// Each rate-limited action's current window (rate-limits.ts): when it started and how many
// times the user has done it since.
export const up = `
CREATE TABLE rate_window (
  action TEXT NOT NULL PRIMARY KEY,
  started_at TEXT NOT NULL ${iso("started_at")},
  count INTEGER NOT NULL CHECK (count >= 0)
) STRICT, WITHOUT ROWID;
`;

export const down = `
DROP TABLE rate_window;
`;
