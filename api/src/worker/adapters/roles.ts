import * as z from "zod";
import type { PermissionName, RoleName, UserId } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { prepare } from "@skolia/util/d1";
import { sql, type Sql } from "@skolia/util/sql";
import type { Roles } from "../../ports/roles.ts";

const Bound = z.object({ role: schemas.RoleName });

/** Seeks role_binding's primary key, in its order. */
function rolesQuery(user: UserId): Sql {
  return sql`SELECT role FROM role_binding WHERE user_id = ${user} ORDER BY role`;
}

/** Seeks role_binding's primary key for the user's roles, then role_permission's for each. */
function grantsQuery(user: UserId, permission: PermissionName): Sql {
  return sql`SELECT 1 AS granted FROM role_binding AS binding
    JOIN role_permission AS granted ON granted.role = binding.role AND granted.permission = ${permission}
    WHERE binding.user_id = ${user} LIMIT 1`;
}

const SOMEONE = schemas.UserId.parse("someone");

/** D1Roles' queries, for the test that checks each one uses an index. */
export const ROLE_QUERIES = {
  roles: rolesQuery(SOMEONE).text,
  grants: grantsQuery(SOMEONE, "unlimited-rate").text,
} as const;

export class D1Roles implements Roles {
  private readonly db: D1Database | D1DatabaseSession;

  constructor(db: D1Database | D1DatabaseSession) {
    this.db = db;
  }

  async of(user: UserId): Promise<readonly RoleName[]> {
    const { results } = await prepare(this.db, rolesQuery(user)).all();
    return results.map((row) => Bound.parse(row).role);
  }

  async grants(user: UserId, permission: PermissionName): Promise<boolean> {
    return (await prepare(this.db, grantsQuery(user, permission)).first()) !== null;
  }
}
