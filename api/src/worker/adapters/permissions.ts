import type { PermissionName, RoleName } from "@skolia/shared/api";
import { prepare } from "@skolia/util/d1";
import { sql, type Sql } from "@skolia/util/sql";
import type { Permissions } from "../../ports/permissions.ts";

/** Seeks role_permission's primary key. */
function grantsQuery(role: RoleName, permission: PermissionName): Sql {
  return sql`SELECT 1 AS granted FROM role_permission WHERE role = ${role} AND permission = ${permission}`;
}

/** D1Permissions' queries, for the test that checks each one uses an index. */
export const PERMISSION_QUERIES = { grants: grantsQuery("standard", "unlimited-rate").text } as const;

export class D1Permissions implements Permissions {
  private readonly db: D1Database | D1DatabaseSession;

  constructor(db: D1Database | D1DatabaseSession) {
    this.db = db;
  }

  async grants(role: RoleName, permission: PermissionName): Promise<boolean> {
    return (await prepare(this.db, grantsQuery(role, permission)).first()) !== null;
  }
}
