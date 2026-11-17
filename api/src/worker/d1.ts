import { compile, type Query } from "@skolia/util/query";
import type { Sql } from "@skolia/util/sql";

export const prepare = (db: D1Database, query: Query | Sql): D1PreparedStatement => {
  const { text, params } = compile(query);
  return db.prepare(text).bind(...params);
};
