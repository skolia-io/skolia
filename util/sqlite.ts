import { sql } from "./sql.ts";

/** Brings SQLite's query planner statistics up to date, as https://www.sqlite.org/pragma.html#pragma_optimize
 * advises: ANALYZE each table that has an index without statistics, or has grown or shrunk tenfold
 * since it was last analysed. The mask's bits: 0x10000 checks every table's size, not only those
 * this connection has queried, since a new connection (a Durable Object that has just started, a
 * deploy's wrangler d1 execute) has none; 0x10 caps the rows ANALYZE reads of each index (Durable
 * Objects and D1 refuse PRAGMA analysis_limit); 0x2 runs ANALYZE. SQLite's own recommendation for a
 * new connection, 0x10002, lacks 0x10, and reads every index in full. */
export const OPTIMIZE = sql`PRAGMA optimize=0x10012`;
