/**
 * formAgent/FormsSidebar.test.ts — unit tests for the forms workspace
 * sidebar helpers.
 *
 * Pins the status → dot-class contract: every real
 * FormCustomizationStatus maps to its own dot class (so a new status can
 * never silently render the wrong color), only in_progress pulses, and
 * unknown values fall back to the neutral base dot instead of inventing
 * a color. Rendering is validated in CI by typecheck + build.
 */
import { describe, expect, it } from 'vitest';
import { statusDotClass } from './FormsSidebar';
import type { FormCustomizationStatus } from '../../formAgent/types';

const ALL_STATUSES: FormCustomizationStatus[] = [
  'requested',
  'in_progress',
  'awaiting_review',
  'completed',
  'blocked',
  'cancelled',
];

describe('statusDotClass', () => {
  it('maps every real status to its own dot class', () => {
    const seen = new Set<string>();
    for (const status of ALL_STATUSES) {
      const cls = statusDotClass(status);
      expect(cls.startsWith('form-status-dot ')).toBe(true);
      // The class carries the real status slug — traceable, no invention.
      expect(cls).toContain(status);
      seen.add(cls.replace(' animate-pulse-dot', ''));
    }
    expect(seen.size).toBe(ALL_STATUSES.length);
  });

  it('pulses only the in-progress dot', () => {
    expect(statusDotClass('in_progress')).toContain('animate-pulse-dot');
    for (const status of ALL_STATUSES.filter((s) => s !== 'in_progress')) {
      expect(statusDotClass(status)).not.toContain('animate-pulse-dot');
    }
  });

  it('falls back honestly for an unknown status', () => {
    expect(statusDotClass('bogus' as FormCustomizationStatus)).toBe(
      'form-status-dot unknown',
    );
  });
});
