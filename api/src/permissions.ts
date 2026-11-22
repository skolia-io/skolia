// Authorization: the code asks whether a user has a permission, which one of the roles
// they're bound to grants (D1's role_binding and role_permission), never what a role is called.
import type { Identity, PermissionName } from "@skolia/shared/api";
import type { Roles } from "./ports/roles.ts";

/** Whether one of the user's roles grants the permission: one query, on the requests that ask. */
export function hasPermission(deps: { roles: Roles }, user: Identity, permission: PermissionName): Promise<boolean> {
  return deps.roles.grants(user.id, permission);
}
