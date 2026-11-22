// Authorization: the code asks whether a user has a permission, which their role grants
// (D1's role_permission), never what their role is called.
import type { PermissionName, User } from "@skolia/shared/api";
import type { Permissions } from "./ports/permissions.ts";

/** Whether the user's role grants the permission: one query, on the requests that ask. */
export function hasPermission(deps: { permissions: Permissions }, user: User, permission: PermissionName): Promise<boolean> {
  return deps.permissions.grants(user.type, permission);
}
