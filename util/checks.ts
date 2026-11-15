// SQLite column checks for SQL written in TypeScript, such as the user Durable Object's
// migrations. An applied migration's SQL is checksummed, so what these make can't change:
// a new kind of check is a new function.

import { type Sql, sql } from "./sql.ts";

/** The column is a time as toISOString() writes it. */
export const iso = (column: string) => `CHECK (${column} IS strftime('%Y-%m-%dT%H:%M:%fZ', ${column}))`;

/** The column is null or a time as toISOString() writes it. */
export const isoOrNull = (column: string) => `CHECK (${column} IS NULL OR ${column} IS strftime('%Y-%m-%dT%H:%M:%fZ', ${column}))`;

/** Each table's columns, generated ones too, beside the table's SQL. Leaves out SQLite's and Cloudflare's tables, and those named. */
export const tableColumns = (except: readonly string[]): Sql =>
  sql`SELECT m.name AS "table", m.sql AS sql, c.name AS "column" FROM sqlite_master AS m JOIN pragma_table_xinfo(m.name) AS c
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' AND m.name NOT IN ${sql.tuple(except)}
    ORDER BY m.name, c.cid`;

export type TableColumn = { readonly table: string; readonly sql: string; readonly column: string };

/** Whether the table's SQL gives the column iso's or isoOrNull's check, with its name quoted or not. */
export const isoChecked = (tableSql: string, column: string): boolean => {
  const spaced = tableSql.replace(/\s+/gu, " ");
  return [column, `"${column}"`].some((name) => spaced.includes(iso(name)) || spaced.includes(isoOrNull(name)));
};

/** The columns whose check makes them timestamps but whose names don't end in _at, and the _at columns without one, as table.column. */
export const timestampNames = (
  columns: readonly TableColumn[],
): { readonly unnamed: readonly string[]; readonly unchecked: readonly string[] } => {
  const named = (c: TableColumn) => `${c.table}.${c.column}`;
  return {
    unnamed: columns.filter((c) => isoChecked(c.sql, c.column) && !c.column.endsWith("_at")).map(named),
    unchecked: columns.filter((c) => c.column.endsWith("_at") && !isoChecked(c.sql, c.column)).map(named),
  };
};
