export const CLASSIFICATIONS = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'PROPRIETARY',
  'CUI',
  'UNKNOWN',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(classification: Classification): number {
  if (classification === 'UNKNOWN') return -1;
  return CLASSIFICATIONS.indexOf(classification);
}

export function canAccessClassification(
  userClearance: Classification,
  resourceClassification: Classification
): boolean {
  if (userClearance === 'UNKNOWN' || resourceClassification === 'UNKNOWN') return false;
  const userRank = classificationRank(userClearance);
  const resourceRank = classificationRank(resourceClassification);
  if (userRank === -1 || resourceRank === -1) return false;
  return userRank >= resourceRank;
}

export const PERMISSIONS = [
  'chat:create',
  'conversation:read',
  'conversation:update',
  'conversation:delete',
  'document:upload',
  'document:read',
  'document:delete',
  'document:classify',
  'model:use',
  'model:manage',
  'tool:use',
  'syteline:read',
  'audit:read',
  'tenant:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  User: [
    'chat:create',
    'conversation:read',
    'conversation:update',
    'conversation:delete',
    'document:upload',
    'document:read',
    'model:use',
    'tool:use',
    'syteline:read',
  ],
  Admin: PERMISSIONS,
  'Security Admin': [
    'audit:read',
    'tenant:manage',
    'conversation:read',
    'document:read',
    'document:classify',
  ],
  'AI Admin': [
    'model:manage',
    'model:use',
    'tool:use',
    'syteline:read',
    'chat:create',
    'conversation:read',
    'document:read',
  ],
  Developer: [
    'chat:create',
    'conversation:read',
    'conversation:update',
    'document:upload',
    'document:read',
    'model:use',
    'tool:use',
    'syteline:read',
  ],
  'Read Only': ['conversation:read', 'document:read'],
};

export interface AuthContext {
  userId: string;
  email: string;
  displayName: string;
  clearance: Classification;
  tenantId: string;
  roleId: string;
  roleName: string;
  permissions: Permission[];
  sessionId: string;
}
