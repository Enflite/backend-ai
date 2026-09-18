import { Classification, canAccessClassification } from '../authz/permissions.js';

export interface PolicySubject {
  userId: string;
  tenantId: string;
  clearance: Classification;
  permissions: readonly string[];
}

export interface PolicyResource {
  tenantId: string;
  classification: Classification;
  ownerId?: string;
  allowedUserIds?: readonly string[];
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export function authorizeResource(subject: PolicySubject, resource: PolicyResource): PolicyDecision {
  if (subject.tenantId !== resource.tenantId) {
    return { allowed: false, reason: 'TENANT_MISMATCH' };
  }
  if (!canAccessClassification(subject.clearance, resource.classification)) {
    return { allowed: false, reason: 'CLASSIFICATION_DENIED' };
  }
  if (
    resource.ownerId &&
    resource.ownerId !== subject.userId &&
    !resource.allowedUserIds?.includes(subject.userId)
  ) {
    return { allowed: false, reason: 'RESOURCE_ACCESS_DENIED' };
  }
  return { allowed: true, reason: 'ALLOWED' };
}

export function canModelProcess(
  dataClassification: Classification,
  modelClassifications: readonly Classification[]
): PolicyDecision {
  if (dataClassification === 'UNKNOWN') {
    return { allowed: false, reason: 'UNKNOWN_CLASSIFICATION' };
  }
  if (!modelClassifications.includes(dataClassification)) {
    return { allowed: false, reason: 'MODEL_CLASSIFICATION_DENIED' };
  }
  return { allowed: true, reason: 'ALLOWED' };
}
