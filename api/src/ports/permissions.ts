import type { PermissionName, RoleName } from "@skolia/shared/api";

/** What roles let their users do: D1's role_permission. */
export interface Permissions {
  /** Whether the role grants the permission. */
  grants(role: RoleName, permission: PermissionName): Promise<boolean>;
}
