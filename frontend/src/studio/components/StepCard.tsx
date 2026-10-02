/**
 * studio/components/StepCard.tsx — one card on the builder canvas.
 *
 * Vertical-canvas register: hairline border, kind micro-label
 * (TRIGGER/ACTION/CONDITION/VERIFY/LOG), summary, mono operation line,
 * and a quiet row of step ops (per-step test, move up/down, duplicate,
 * delete). Test results render inline from the real API only.
 */
import type { ReactNode } from 'react';
import { Badge, IconButton } from '../../components/ui/primitives';
import type { StudioAction, StudioStep, StudioStepTestResult } from '../types';
import { stepKindLabel, stepOperation, summarizeStep } from '../builder';
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconPlay,
  IconTrash,
} from './StudioIcons';

export interface StepCardProps {
  step: StudioStep;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  selected: boolean;
  readOnly: boolean;
  canTest: boolean;
  catalogById: Map<string, StudioAction>;
  /** Real dry-run results keyed by step id (from POST /:id/test). */
  testResult?: StudioStepTestResult;
  testing: boolean;
  /** Per-step single-action test state for this card. */
  stepTestBusy: boolean;
  stepTestResultOpen: boolean;
  onSelect: () => void;
  onMove: (dir: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onTestStep: () => void;
  onToggleStepResult: () => void;
}

function resultTone(status: string): { dot: string; text: string } {
  const s = status.toLowerCase();
  if (s === 'ok') return { dot: '#6ee7a1', text: 'passed' };
  if (s === 'skipped') return { dot: '#d9aa68', text: 'skipped' };
  return { dot: '#d28279', text: s === 'failed' ? 'failed' : status };
}

function ResultBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mt-2">
      <p className="text-[9px] font-bold uppercase" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.08em' }}>
        {label}
      </p>
      <pre className="studio-result-pre mt-1 rounded px-2 py-1.5" style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }}>
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function StepCard(props: StepCardProps) {
  const {
    step, index, isFirst, isLast, selected, readOnly, canTest,
    catalogById, testResult, testing, stepTestBusy, stepTestResultOpen,
    onSelect, onMove, onDuplicate, onDelete, onTestStep, onToggleStepResult,
  } = props;

  const action = step.actionId ? catalogById.get(step.actionId) : undefined;
  const summary = summarizeStep(step, action);
  const operation = stepOperation(step, action);
  const tone = testResult ? resultTone(testResult.status) : null;

  const ops: ReactNode[] = [];
  if (canTest && step.kind === 'action' && action?.supported && step.actionId) {
    ops.push(
      <IconButton key="test" label={`Test step ${index + 1} against the live connection`} onClick={onTestStep} disabled={stepTestBusy || testing}>
        <IconPlay size={14} />
      </IconButton>,
    );
  }
  if (!readOnly) {
    ops.push(
      <IconButton key="up" label={`Move step ${index + 1} up`} onClick={() => onMove(-1)} disabled={isFirst}>
        <IconChevronUp size={14} />
      </IconButton>,
      <IconButton key="down" label={`Move step ${index + 1} down`} onClick={() => onMove(1)} disabled={isLast}>
        <IconChevronDown size={14} />
      </IconButton>,
      <IconButton key="dup" label={`Duplicate step ${index + 1}`} onClick={onDuplicate}>
        <IconCopy size={14} />
      </IconButton>,
      <IconButton key="del" label={`Delete step ${index + 1}`} onClick={onDelete}>
        <IconTrash size={14} />
      </IconButton>,
    );
  }

  return (
    <div
      role="button"
      tabIndex={readOnly ? -1 : 0}
      aria-pressed={selected}
      aria-label={`Step ${index + 1}: ${summary}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (!readOnly && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`rounded-lg px-4 py-3 text-left w-full ${selected ? 'studio-step-selected' : ''}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        cursor: readOnly ? 'default' : 'pointer',
        transition: 'border-color 160ms ease, box-shadow 160ms ease',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="font-mono text-[9px] font-bold uppercase"
              style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
            >
              {stepKindLabel(step.kind)}
            </span>
            <span className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
              #{index + 1}
            </span>
            {action?.destructive && (
              <Badge tone="red" title="This action mutates SyteLine state">destructive</Badge>
            )}
            {step.kind === 'action' && action && !action.supported && (
              <Badge tone="amber" title={action.supportReason ?? 'Not supported by this connection'}>
                unsupported
              </Badge>
            )}
          </div>
          <p className="mt-1 font-semibold truncate" style={{ fontSize: 'var(--text-body)', color: 'var(--foreground)' }}>
            {summary}
          </p>
          {operation && (
            <p className="mt-0.5 font-mono truncate" style={{ fontSize: 'var(--text-meta)', color: 'var(--muted-foreground)' }}>
              {operation}
            </p>
          )}
        </div>
        {ops.length > 0 && (
          <div className="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {ops}
          </div>
        )}
      </div>

      {/* Inline dry-run result — from the real API only. */}
      {testResult && tone && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="studio-dot" style={{ background: tone.dot }} />
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {tone.text === 'passed' ? <><IconCheck size={12} /> </> : tone.text === 'failed' ? <><IconAlert size={12} /> </> : null}
              Step {tone.text}
            </span>
            {typeof testResult.durationMs === 'number' && (
              <span className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                {testResult.durationMs}ms
              </span>
            )}
            {(testResult.request !== undefined || testResult.response !== undefined) && (
              <button
                type="button"
                className="ml-auto font-mono text-[10px] underline"
                style={{ color: 'var(--muted-foreground)' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStepResult();
                }}
                aria-expanded={stepTestResultOpen}
              >
                {stepTestResultOpen ? 'hide details' : 'show details'}
              </button>
            )}
          </div>
          {testResult.error && (
            <p className="mt-1.5 text-xs" style={{ color: '#d28279' }}>{testResult.error}</p>
          )}
          {stepTestResultOpen && (
            <div onClick={(e) => e.stopPropagation()}>
              {testResult.request !== undefined && <ResultBlock label="Request" value={testResult.request} />}
              {testResult.response !== undefined && <ResultBlock label="Response" value={testResult.response} />}
            </div>
          )}
        </div>
      )}
      {stepTestBusy && (
        <p className="mt-2 font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
          testing against live connection…
        </p>
      )}
    </div>
  );
}
