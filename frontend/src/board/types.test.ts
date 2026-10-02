/**
 * board/types.test.ts — unit tests for the kanban board data model.
 *
 * Pure normalizers and helpers: fully deterministic, no network.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import {
  BOARD_COLUMNS,
  COLUMN_META,
  KIND_META,
  classifySourceError,
  completedDay,
  formToCard,
  isTerminalColumn,
  localDay,
  relativeTime,
  taskToCard,
  type BoardCard,
} from './types';
import type { SytelineTaskListItem } from '../api/tasks';
import type { FormCustomizationListItem } from '../formAgent/types';

const TASK_BASE: SytelineTaskListItem = {
  _id: 'task-1',
  title: 'Check why order 12345 is late',
  status: 'in_progress',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
};

const FORM_BASE: FormCustomizationListItem = {
  id: 'form-1',
  status: 'requested',
  formName: 'Items',
  title: 'Add vendor code field',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
};

describe('taskToCard', () => {
  it('maps every task status onto a board column', () => {
    const expected: Record<SytelineTaskListItem['status'], BoardCard['status']> = {
      assigned: 'assigned',
      in_progress: 'in_progress',
      completed: 'completed',
      blocked: 'blocked',
      cancelled: 'cancelled',
    };
    for (const [taskStatus, column] of Object.entries(expected)) {
      const item = { ...TASK_BASE, status: taskStatus as SytelineTaskListItem['status'] };
      const card = taskToCard(item);
      expect(card.status).toBe(column);
      expect(card.kind).toBe('task');
      expect(card.id).toBe('task-1');
      expect(card.title).toBe('Check why order 12345 is late');
      expect(card.createdAt).toBe(TASK_BASE.createdAt);
      expect(card.updatedAt).toBe(TASK_BASE.updatedAt);
      expect(card.raw).toBe(item);
    }
  });

  it('preserves completedAt when present', () => {
    const card = taskToCard({ ...TASK_BASE, status: 'completed', completedAt: '2026-10-02T11:00:00.000Z' });
    expect(card.completedAt).toBe('2026-10-02T11:00:00.000Z');
  });

  it('leaves completedAt undefined when absent', () => {
    expect(taskToCard(TASK_BASE).completedAt).toBeUndefined();
  });
});

describe('formToCard', () => {
  it('maps every form status onto a board column', () => {
    const expected: Record<FormCustomizationListItem['status'], BoardCard['status']> = {
      requested: 'assigned',
      in_progress: 'in_progress',
      awaiting_review: 'awaiting_review',
      completed: 'completed',
      blocked: 'blocked',
      cancelled: 'cancelled',
    };
    for (const [formStatus, column] of Object.entries(expected)) {
      const card = formToCard({ ...FORM_BASE, status: formStatus as FormCustomizationListItem['status'] });
      expect(card.status).toBe(column);
      expect(card.kind).toBe('form');
      expect(card.id).toBe('form-1');
      // The form name becomes the card subtitle.
      expect(card.subtitle).toBe('Items');
    }
  });
});

describe('board shape', () => {
  it('defines exactly six columns with labels', () => {
    expect(BOARD_COLUMNS).toEqual(['assigned', 'in_progress', 'awaiting_review', 'completed', 'blocked', 'cancelled']);
    for (const column of BOARD_COLUMNS) {
      expect(COLUMN_META[column].label.length).toBeGreaterThan(0);
    }
  });

  it('marks flow/schedule/batch as unavailable in kind meta', () => {
    expect(KIND_META.task.available).toBe(true);
    expect(KIND_META.form.available).toBe(true);
    expect(KIND_META.flow.available).toBe(false);
    expect(KIND_META.schedule.available).toBe(false);
    expect(KIND_META.batch.available).toBe(false);
  });

  it('treats completed/blocked/cancelled as terminal', () => {
    expect(isTerminalColumn('completed')).toBe(true);
    expect(isTerminalColumn('blocked')).toBe(true);
    expect(isTerminalColumn('cancelled')).toBe(true);
    expect(isTerminalColumn('assigned')).toBe(false);
    expect(isTerminalColumn('in_progress')).toBe(false);
    expect(isTerminalColumn('awaiting_review')).toBe(false);
  });
});

describe('classifySourceError', () => {
  it('maps SYTELINE_UI_DISABLED and FEATURE_DISABLED to disabled', () => {
    expect(classifySourceError(new ApiError(500, 'SYTELINE_UI_DISABLED', 'disabled'))).toBe('disabled');
    expect(classifySourceError(new ApiError(403, 'FEATURE_DISABLED', 'disabled'))).toBe('disabled');
  });

  it('maps 403 and forbidden codes to forbidden', () => {
    expect(classifySourceError(new ApiError(403, 'FORBIDDEN', 'no'))).toBe('forbidden');
    expect(classifySourceError(new ApiError(403, 'TOOL_FORBIDDEN', 'no'))).toBe('forbidden');
    expect(classifySourceError(new ApiError(403, 'CLASSIFICATION_DENIED', 'no'))).toBe('forbidden');
  });

  it('maps anything else to error', () => {
    expect(classifySourceError(new ApiError(500, 'INTERNAL', 'boom'))).toBe('error');
    expect(classifySourceError(new Error('network down'))).toBe('error');
    expect(classifySourceError(null)).toBe('error');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-10-02T14:00:00.000Z');
  it('renders friendly relative times', () => {
    expect(relativeTime('2026-10-02T13:59:50.000Z', now)).toBe('just now');
    expect(relativeTime('2026-10-02T13:55:00.000Z', now)).toBe('5m ago');
    expect(relativeTime('2026-10-02T12:00:00.000Z', now)).toBe('2h ago');
    expect(relativeTime('2026-10-01T14:00:00.000Z', now)).toBe('1d ago');
    expect(relativeTime('2026-09-20T14:00:00.000Z', now)).toBe(
      new Date('2026-09-20T14:00:00.000Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
  });

  it('returns an empty string for invalid dates', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('completedDay', () => {
  it('uses completedAt for completed cards', () => {
    const card = taskToCard({ ...TASK_BASE, status: 'completed', completedAt: '2026-10-02T11:00:00.000Z' });
    expect(completedDay(card)).toBe(localDay(new Date('2026-10-02T11:00:00.000Z')));
  });

  it('falls back to updatedAt when completedAt is missing', () => {
    const card = taskToCard({ ...TASK_BASE, status: 'completed' });
    expect(completedDay(card)).toBe(localDay(new Date(TASK_BASE.updatedAt)));
  });

  it('returns null for non-completed cards', () => {
    expect(completedDay(taskToCard(TASK_BASE))).toBeNull();
    expect(completedDay(formToCard(FORM_BASE))).toBeNull();
  });
});
