import { compile, type Query } from "./query.ts";
import type { Sql } from "./sql.ts";

/** What prepare needs of a D1Database, so util needs no Workers types */
type Database<Statement> = { prepare(query: string): { bind(...values: unknown[]): Statement } };

export const prepare = <Statement>(db: Database<Statement>, query: Query | Sql): Statement => {
  const { text, params } = compile(query);
  return db.prepare(text).bind(...params);
};
