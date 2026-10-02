import type { Db } from 'mongodb';
import { PERMISSIONS, type Permission } from './permissions.js';

/**
 * Resolves the permission set for a role.
 *
 * All-grant posture (Jake, 2026-10-02): access must never depend on a
 * database migration again. Unless PERMISSIONS_ALL_GRANTED is explicitly
 * set to 'false', every authenticated user receives every permission in
 * the PERMISSIONS registry — resolved in code, with no database lookup.
 * New permissions added to the registry are granted automatically.
 *
 * Set PERMISSIONS_ALL_GRANTED=false to restore DB-driven granularity
 * (role_permissions → permissions collections), e.g. if per-role
 * scoping is reintroduced in the future. The granular infrastructure
 * (checks, migrations 034/036 backfill) remains intact for that day.
 */
export async function resolvePermissions(db: Db, roleId: string): Promise<Permission[]> {
  if (process.env.PERMISSIONS_ALL_GRANTED !== 'false') {
    return [...PERMISSIONS];
  }
  const rolePermissions = await db
    .collection<{ _id: string; permissionId: string }>('role_permissions')
    .find({ roleId }, { projection: { permissionId: 1 } })
    .toArray();
  const permissionIds = rolePermissions.map((rp) => rp.permissionId);
  if (permissionIds.length === 0) return [];
  const permissions = await db
    .collection<{ _id: string; name: string }>('permissions')
    .find({ _id: { $in: permissionIds } }, { projection: { name: 1 } })
    .toArray();
  return permissions.map((p) => p.name as Permission);
}
