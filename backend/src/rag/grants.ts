/**
 * Shared document-grant authorization predicate.
 *
 * Extracted from rag/retrieval.ts so the chat image-attachment path
 * (chat/imageAttachments.ts) mirrors RAG document authorization exactly
 * without importing the whole retrieval module. Both call sites enforce the
 * same owner-or-grant rule: a caller may read a document when they own it or
 * hold a `document_permissions` grant matching exactly one of their
 * principals (user, role, department, security group). Absent principals are
 * omitted, never null.
 */
import { Db } from 'mongodb';
import { AuthContext } from '../authz/permissions.js';

export async function grantPrincipalOr(db: Db, auth: AuthContext): Promise<Record<string, unknown>[]> {
  const [deptRows, groupRows] = await Promise.all([
    db.collection<{ departmentId: string }>('department_memberships')
      .find({ userId: auth.userId }, { projection: { departmentId: 1 } }).toArray(),
    db.collection<{ groupId: string }>('security_group_memberships')
      .find({ userId: auth.userId }, { projection: { groupId: 1 } }).toArray(),
  ]);
  const or: Record<string, unknown>[] = [{ userId: auth.userId }];
  if (auth.roleId) or.push({ roleId: auth.roleId });
  const departmentIds = deptRows.map((row) => row.departmentId);
  const groupIds = groupRows.map((row) => row.groupId);
  if (departmentIds.length > 0) or.push({ departmentId: { $in: departmentIds } });
  if (groupIds.length > 0) or.push({ groupId: { $in: groupIds } });
  return or;
}
