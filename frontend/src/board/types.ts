/**
 * board/types.ts — kanban board data model.
 *
 * The board unifies the platform's work items (SyteLine task-agent runs,
 * form customizations today) into a single set of cards and columns.
 * Flows, Schedules, and Batch are declared as kinds up front with their
 * cards marked "coming soon": when those APIs land, they plug in by adding
 * a `*ToCard` normalizer and a fetch — no board rewrite.
 */
import type { SytelineTaskListItem, SytelineTaskStatus } from '../api/tasks';
import type { FormCustomizationListItem, FormCustomizationStatus } from '../formAgent/types';
import { ApiError } from '../api';

export type BoardCardKind = 'task' | 'form' | 'flow' | 'schedule' | 'batch';

export interface KindMeta {
  /** Short label shown on the card badge. */
  label: string;
  color: string;
  bg: string;
  /** False until the source API exists — no cards of this kind can appear. */
  available: boolean;
}

export const KIND_META: Record<BoardCardKind, KindMeta> = {
  task: { label: 'Task', color: '#1d4ed8', bg: '#2563eb14', available: true },
  form: { label: 'Form', color: '#7c3aed', bg: '#7c3aed14', available: true },
  flow: { label: 'Flow', color: 'var(--muted-foreground)', bg: 'var(--secondary)', available: false },
  schedule: { label: 'Schedule', color: 'var(--muted-foreground)', bg: 'var(--secondary)', available: false },
  batch: { label: 'Batch', color: 'var(--muted-foreground)', bg: 'var(--secondary)', available: false },
};

export type BoardColumnId =
  | 'assigned'
  | 'in_progress'
  | 'awaiting_review'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export const BOARD_COLUMNS: readonly BoardColumnId[] = [
  'assigned',
  'in_progress',
  'awaiting_review',
  'completed',
  'blocked',
  'cancelled',
];

export const COLUMN_META: Record<BoardColumnId, { label: string }> = {
  assigned: { label: 'Assigned' },
  in_progress: { label: 'In progress' },
  awaiting_review: { label: 'Awaiting review' },
  completed: { label: 'Completed' },
  blocked: { label: 'Blocked' },
  cancelled: { label: 'Cancelled' },
};

/**
 * A board card — the unified view of one unit of work. `raw` keeps the
 * original source payload so future kinds (flow/schedule/batch) and the
 * detail views can reach source-specific fields without a second fetch.
 */
export interface BoardCard {
  kind: BoardCardKind;
  id: string;
  title: string;
  subtitle?: string;
  status: BoardColumnId;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Who requested the work (e.g. requester user id) when the source exposes it. */
  actor?: string;
  raw: unknown;
}

function card(
  kind: BoardCardKind,
  id: string,
  title: string,
  status: BoardColumnId,
  createdAt: string,
  updatedAt: string,
  rest: { subtitle?: string; completedAt?: string; actor?: string; raw: unknown },
): BoardCard {
  return {
    kind,
    id,
    title,
    status,
    createdAt,
    updatedAt,
    subtitle: rest.subtitle,
    completedAt: rest.completedAt,
    actor: rest.actor,
    raw: rest.raw,
  };
}

const TASK_STATUS_TO_COLUMN: Record<SytelineTaskStatus, BoardColumnId> = {
  assigned: 'assigned',
  in_progress: 'in_progress',
  completed: 'completed',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

const FORM_STATUS_TO_COLUMN: Record<FormCustomizationStatus, BoardColumnId> = {
  requested: 'assigned',
  in_progress: 'in_progress',
  awaiting_review: 'awaiting_review',
  completed: 'completed',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

/** Normalize a SyteLine task-agent list item onto a board card. */
export function taskToCard(item: SytelineTaskListItem): BoardCard {
  return card('task', item._id, item.title, TASK_STATUS_TO_COLUMN[item.status] ?? 'assigned', item.createdAt, item.updatedAt, {
    completedAt: item.completedAt,
    raw: item,
  });
}

/** Normalize a form-customization list item onto a board card. */
export function formToCard(item: FormCustomizationListItem): BoardCard {
  return card('form', item.id, item.title, FORM_STATUS_TO_COLUMN[item.status] ?? 'assigned', item.createdAt, item.updatedAt, {
    subtitle: item.formName,
    raw: item,
  });
}

const TERMINAL_COLUMNS: ReadonlySet<BoardColumnId> = new Set(['completed', 'blocked', 'cancelled']);

export function isTerminalColumn(column: BoardColumnId): boolean {
  return TERMINAL_COLUMNS.has(column);
}

/** Per-source fetch health, tracked independently per data source. */
export type SourceHealth = 'loading' | 'ok' | 'disabled' | 'forbidden' | 'error';

const DISABLED_CODES = new Set(['SYTELINE_UI_DISABLED', 'FEATURE_DISABLED']);
const FORBIDDEN_CODES = new Set(['TOOL_FORBIDDEN', 'FORBIDDEN', 'CLASSIFICATION_DENIED', 'TOOL_CLASSIFICATION_DENIED']);

/**
 * Classify a fetch failure into a board-friendly source state so views can
 * render DisabledState / NotAuthorizedState instead of raw errors.
 */
export function classifySourceError(error: unknown): Exclude<SourceHealth, 'loading' | 'ok'> {
  if (error instanceof ApiError) {
    if (DISABLED_CODES.has(error.code)) return 'disabled';
    if (error.status === 403 || FORBIDDEN_CODES.has(error.code)) return 'forbidden';
  }
  return 'error';
}

/**
 * Human-friendly relative time ("just now", "5m ago", "3h ago", "2d ago",
 * or a short date for older items). `now` is injectable for tests.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = now.getTime() - then;
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Full local timestamp for detail views ("Oct 2, 2026, 1:59 PM").
 */
export function fullTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The local calendar day (YYYY-MM-DD) a card completed on — completedAt
 * with an updatedAt fallback, per the "what did the AI complete today" spec.
 */
export function completedDay(card: BoardCard): string | null {
  if (card.status !== 'completed') return null;
  const iso = card.completedAt ?? card.updatedAt;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Local calendar day (YYYY-MM-DD) of a Date — for the day picker default. */
export function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
