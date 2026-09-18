import { describe, it, expect } from 'vitest';
import {
  CLASSIFICATIONS,
  classificationRank,
  canAccessClassification,
  ROLE_PERMISSIONS,
} from '../src/authz/permissions.js';

describe('Authorization & Classification', () => {
  describe('Classification Ordering', () => {
    it('orders classifications strictly from lowest to highest sensitivity', () => {
      expect(CLASSIFICATIONS).toEqual([
        'PUBLIC',
        'INTERNAL',
        'CONFIDENTIAL',
        'PROPRIETARY',
        'CUI',
        'UNKNOWN',
      ]);

      expect(classificationRank('PUBLIC')).toBe(0);
      expect(classificationRank('INTERNAL')).toBe(1);
      expect(classificationRank('CONFIDENTIAL')).toBe(2);
      expect(classificationRank('PROPRIETARY')).toBe(3);
      expect(classificationRank('CUI')).toBe(4);
      expect(classificationRank('UNKNOWN')).toBe(-1);
    });

    it('denies UNKNOWN in every direction', () => {
      expect(canAccessClassification('CUI', 'UNKNOWN')).toBe(false);
      expect(canAccessClassification('UNKNOWN', 'PUBLIC')).toBe(false);
      expect(canAccessClassification('UNKNOWN', 'UNKNOWN')).toBe(false);
    });

    it('denies access when user clearance is lower than resource classification', () => {
      // PUBLIC user cannot access anything above PUBLIC
      expect(canAccessClassification('PUBLIC', 'INTERNAL')).toBe(false);
      expect(canAccessClassification('PUBLIC', 'CONFIDENTIAL')).toBe(false);
      expect(canAccessClassification('PUBLIC', 'PROPRIETARY')).toBe(false);
      expect(canAccessClassification('PUBLIC', 'CUI')).toBe(false);

      // INTERNAL user cannot access CONFIDENTIAL, PROPRIETARY, CUI
      expect(canAccessClassification('INTERNAL', 'CONFIDENTIAL')).toBe(false);
      expect(canAccessClassification('INTERNAL', 'PROPRIETARY')).toBe(false);
      expect(canAccessClassification('INTERNAL', 'CUI')).toBe(false);

      // CONFIDENTIAL user cannot access PROPRIETARY, CUI
      expect(canAccessClassification('CONFIDENTIAL', 'PROPRIETARY')).toBe(false);
      expect(canAccessClassification('CONFIDENTIAL', 'CUI')).toBe(false);

      // PROPRIETARY user cannot access CUI
      expect(canAccessClassification('PROPRIETARY', 'CUI')).toBe(false);
    });

    it('allows access when user clearance is equal or higher than resource classification', () => {
      // Equal rank
      expect(canAccessClassification('PUBLIC', 'PUBLIC')).toBe(true);
      expect(canAccessClassification('INTERNAL', 'INTERNAL')).toBe(true);
      expect(canAccessClassification('CONFIDENTIAL', 'CONFIDENTIAL')).toBe(true);
      expect(canAccessClassification('PROPRIETARY', 'PROPRIETARY')).toBe(true);
      expect(canAccessClassification('CUI', 'CUI')).toBe(true);

      // Higher clearance accessing lower classification
      expect(canAccessClassification('CUI', 'PUBLIC')).toBe(true);
      expect(canAccessClassification('CUI', 'INTERNAL')).toBe(true);
      expect(canAccessClassification('CUI', 'CONFIDENTIAL')).toBe(true);
      expect(canAccessClassification('CUI', 'PROPRIETARY')).toBe(true);

      expect(canAccessClassification('PROPRIETARY', 'PUBLIC')).toBe(true);
      expect(canAccessClassification('PROPRIETARY', 'INTERNAL')).toBe(true);

      expect(canAccessClassification('INTERNAL', 'PUBLIC')).toBe(true);
    });
  });

  describe('Role Permissions', () => {
    it('asserts User role does NOT have audit:read', () => {
      const userPerms = ROLE_PERMISSIONS['User'];
      expect(userPerms).toBeDefined();
      expect(userPerms?.includes('audit:read')).toBe(false);
    });

    it('asserts Security Admin DOES have audit:read', () => {
      const secAdminPerms = ROLE_PERMISSIONS['Security Admin'];
      expect(secAdminPerms).toBeDefined();
      expect(secAdminPerms?.includes('audit:read')).toBe(true);
    });

    it('asserts Developer role does NOT have tenant:manage', () => {
      const devPerms = ROLE_PERMISSIONS['Developer'];
      expect(devPerms).toBeDefined();
      expect(devPerms?.includes('tenant:manage')).toBe(false);
    });

    it('asserts Admin has all permissions', () => {
      const adminPerms = ROLE_PERMISSIONS['Admin'];
      expect(adminPerms).toBeDefined();
      expect(adminPerms?.includes('audit:read')).toBe(true);
      expect(adminPerms?.includes('tenant:manage')).toBe(true);
      expect(adminPerms?.includes('chat:create')).toBe(true);
    });
  });
});
