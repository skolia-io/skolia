import type { PermissionName, RoleName, UserId } from "@skolia/shared/api";

/** The roles users are bound to (D1's role_binding), and what those roles grant (role_permission). */
export interface Roles {
  /** The user's roles, by name; none for someone who signed up. */
  of(user: UserId): Promise<readonly RoleName[]>;
  /** Whether one of the user's roles grants the permission. */
  grants(user: UserId, permission: PermissionName): Promise<boolean>;
}
