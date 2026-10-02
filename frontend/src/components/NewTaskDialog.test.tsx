/**
 * components/NewTaskDialog.test.tsx — unit tests for the new-task dialog's
 * data contracts.
 *
 * Covers the pure helpers: the two real pipeline targets (ids, permissions),
 * the default-target selection from a permission set, the start-button gate,
 * and the honesty invariant that every suggestion chip is a plain static
 * string (a shortcut that fills the textarea, never fake AI).
 * Component rendering is validated in CI by typecheck + build.
 */
import { describe, expect, it } from 'vitest';
import {
  canStartSytelineTask,
  defaultTargetId,
  SUGGESTED_PROMPTS,
  TASK_TARGETS,
} from './NewTaskDialog';

describe('TASK_TARGETS', () => {
  it('binds exactly the two real pipelines — no static/fake targets', () => {
    expect(TASK_TARGETS.map((target) => target.id)).toEqual(['syteline', 'forms']);
  });

  it('gates each target on its real permission', () => {
    const byId = Object.fromEntries(TASK_TARGETS.map((target) => [target.id, target]));
    expect(byId.syteline.permission).toBe('syteline:ui');
    expect(byId.forms.permission).toBe('syteline:forms');
  });

  it('gives every target a label, description, and icon', () => {
    for (const target of TASK_TARGETS) {
      expect(target.label.length).toBeGreaterThan(0);
      expect(target.description.length).toBeGreaterThan(0);
      expect(target.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('defaultTargetId', () => {
  it('prefers the SyteLine pipeline when the user may use it', () => {
    expect(defaultTargetId(['syteline:ui'])).toBe('syteline');
    expect(defaultTargetId(['syteline:ui', 'syteline:forms'])).toBe('syteline');
  });

  it('falls back to forms when only the forms permission is held', () => {
    expect(defaultTargetId(['syteline:forms'])).toBe('forms');
  });

  it('falls back to SyteLine when nothing is held (both cards lock)', () => {
    expect(defaultTargetId([])).toBe('syteline');
  });
});

describe('canStartSytelineTask', () => {
  const ready = {
    title: 'Check why order 12345 is late',
    goal: 'Find the root cause.',
    busy: false,
    hasPermission: true,
  };

  it('allows a complete, permitted submission', () => {
    expect(canStartSytelineTask(ready)).toBe(true);
  });

  it('blocks blank title or goal', () => {
    expect(canStartSytelineTask({ ...ready, title: '  ' })).toBe(false);
    expect(canStartSytelineTask({ ...ready, goal: '' })).toBe(false);
  });

  it('blocks while a creation is in flight', () => {
    expect(canStartSytelineTask({ ...ready, busy: true })).toBe(false);
  });

  it('blocks when the user lacks the SyteLine task permission', () => {
    expect(canStartSytelineTask({ ...ready, hasPermission: false })).toBe(false);
  });
});

describe('SUGGESTED_PROMPTS', () => {
  it('ships honest static starters that fill the textarea', () => {
    expect(SUGGESTED_PROMPTS.length).toBeGreaterThan(0);
    for (const prompt of SUGGESTED_PROMPTS) {
      expect(typeof prompt).toBe('string');
      expect(prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('stays SyteLine-flavored — no generic dev-task placeholders', () => {
    const joined = SUGGESTED_PROMPTS.join(' ').toLowerCase();
    expect(joined).toMatch(/syteline|sales order|purchase order|vendor|task/);
  });
});
