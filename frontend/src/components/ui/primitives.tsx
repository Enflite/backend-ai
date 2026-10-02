/**
 * ui/primitives.tsx — shared building blocks for the Enflite redesign.
 *
 * Every surface (Chat, Board, Form AI, SyteLine, Knowledge, and the upcoming
 * APS Planning Agent views) builds from these instead of inventing its own
 * buttons, inputs, badges, and dialogs. Visual rules live in
 * docs/frontend-design-system.md; the tokens live in index.css.
 *
 * Do not add one-off styled buttons/inputs elsewhere — extend these.
 */
import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import type { DataClassification } from '../../types';

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_BASE: string =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-md whitespace-nowrap ' +
  'disabled:opacity-50 disabled:cursor-not-allowed select-none';

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'text-xs px-2.5 py-1.5',
  md: 'text-sm px-3.5 py-2',
};

const BUTTON_VARIANT: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: 'var(--accent)', color: 'var(--accent-foreground)' },
  secondary: { background: 'var(--secondary)', color: 'var(--foreground)' },
  outline: { background: 'transparent', color: 'var(--foreground)', border: '1px solid var(--border)' },
  ghost: { background: 'transparent', color: 'var(--muted-foreground)' },
  danger: { background: 'var(--accent)', color: 'var(--accent-foreground)' },
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = 'secondary', size = 'md', className = '', style, ...rest }: ButtonProps) {
  const hover =
    variant === 'ghost' ? 'hover:bg-secondary hover:text-foreground'
    : variant === 'outline' ? 'hover:bg-secondary'
    : variant === 'primary' ? 'hover:brightness-95'
    : 'hover:brightness-[0.97]';
  return (
    <button
      className={`${BUTTON_BASE} ${BUTTON_SIZE[size]} ${hover} ${className}`}
      style={{ ...BUTTON_VARIANT[variant], ...style }}
      {...rest}
    />
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: number;
}

/** Ghost icon button with an accessible name. */
export function IconButton({ label, size = 16, className = '', children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`p-1.5 rounded-md hover:bg-secondary inline-flex items-center justify-center flex-shrink-0 ${className}`}
      style={{ color: 'var(--muted-foreground)' }}
      {...rest}
    >
      <span className="inline-flex" style={{ width: size, height: size }} aria-hidden="true">
        {children}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

type BadgeTone = 'neutral' | 'red' | 'green' | 'blue' | 'amber' | 'purple' | 'gray';

const BADGE_TONE: Record<BadgeTone, { color: string; bg: string; border: string }> = {
  neutral: { color: 'var(--foreground)', bg: 'var(--secondary)', border: 'var(--border)' },
  red: { color: 'var(--danger)', bg: '#cf0c2c14', border: '#cf0c2c40' },
  green: { color: '#15803d', bg: '#15803d14', border: '#15803d40' },
  blue: { color: '#1d4ed8', bg: '#2563eb14', border: '#2563eb40' },
  amber: { color: '#b45309', bg: '#b4530914', border: '#b4530940' },
  purple: { color: '#7e22ce', bg: '#7e22ce14', border: '#7e22ce40' },
  gray: { color: 'var(--muted-foreground)', bg: 'var(--secondary)', border: 'var(--border)' },
};

export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  const t = BADGE_TONE[tone];
  return (
    <span
      title={title}
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap"
      style={{ background: t.bg, color: t.color, border: `1px solid ${t.border}` }}
    >
      {children}
    </span>
  );
}

const CLASSIFICATION_TONE: Record<DataClassification, BadgeTone> = {
  PUBLIC: 'green',
  INTERNAL: 'blue',
  CONFIDENTIAL: 'amber',
  PROPRIETARY: 'red',
  CUI: 'purple',
  UNKNOWN: 'gray',
};

export const CLASSIFICATION_DESCRIPTIONS: Record<Exclude<DataClassification, 'UNKNOWN'>, string> = {
  PUBLIC: 'Anyone can access',
  INTERNAL: 'Enflite internal information',
  CONFIDENTIAL: 'Restricted business information',
  PROPRIETARY: 'Sensitive company information',
  CUI: 'Controlled Unclassified Information',
};

/**
 * The shared classification pill — the recognizable security control.
 * Always reflects the app's real classification levels; never invent levels.
 */
export function ClassificationBadge({ level, showDot = true }: { level: DataClassification; showDot?: boolean }) {
  return (
    <Badge tone={CLASSIFICATION_TONE[level]} title={`Data classification: ${level}`}>
      {showDot && (
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 rounded-full mr-1.5"
          style={{ background: BADGE_TONE[CLASSIFICATION_TONE[level]].color }}
        />
      )}
      {level}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

export function Card({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={`rounded-lg ${className}`}
      style={{ background: 'var(--card)', border: '1px solid var(--border)', ...style }}
    >
      {children}
    </div>
  );
}

/** Small uppercase section label used for nav groups and panel sections. */
export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`text-[11px] font-semibold uppercase tracking-widest ${className}`}
      style={{ color: 'var(--muted-foreground)' }}
    >
      {children}
    </p>
  );
}

/** Page header: title + optional description + trailing actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-shrink-0">
      <div className="min-w-0">
        <h1 className="font-semibold truncate" style={{ fontSize: 'var(--text-page-title)', color: 'var(--foreground)' }}>
          {title}
        </h1>
        {description && (
          <p className="mt-0.5" style={{ fontSize: 'var(--text-secondary)', color: 'var(--muted-foreground)' }}>
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function TextInput({ label, id, className = '', style, ...rest }: TextInputProps) {
  const inputId = id ?? `input-${Math.random().toString(36).slice(2)}`;
  return (
    <label className={`block ${className}`} style={style}>
      {label && (
        <span className="block text-xs font-medium mb-1" style={{ color: 'var(--foreground)' }}>
          {label}
        </span>
      )}
      <input
        id={inputId}
        className="w-full rounded-md px-3 py-2 text-sm bg-transparent"
        style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
        {...rest}
      />
    </label>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

export function Select({ label, id, className = '', children, ...rest }: SelectProps) {
  const inputId = id ?? `select-${Math.random().toString(36).slice(2)}`;
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="block text-xs font-medium mb-1" style={{ color: 'var(--foreground)' }}>
          {label}
        </span>
      )}
      <select
        id={inputId}
        className="rounded-md px-2 py-1.5 text-sm bg-transparent"
        style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
        {...rest}
      >
        {children}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Loading & status indicators                                         */
/* ------------------------------------------------------------------ */

/**
 * Skeleton — shimmering placeholder block while content loads.
 * Decorative only (aria-hidden); wrap with a labeled container when the
 * loading state needs a name.
 */
export function Skeleton({
  width = '100%',
  height = '1rem',
  className = '',
  style,
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      className={`skeleton-shimmer rounded ${className}`}
      style={{ width, height, ...style }}
    />
  );
}

/** Kbd — keyboard-hint chip for shortcut documentation. */
export function Kbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono leading-none ${className}`}
      style={{
        background: 'var(--secondary)',
        border: '1px solid var(--border)',
        borderBottomWidth: 2,
        color: 'var(--foreground)',
      }}
    >
      {children}
    </kbd>
  );
}

/** LiveDot — pulsing dot + text label for live/connected states. */
export function LiveDot({ label = 'live', className = '' }: { label?: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}
      style={{ color: 'var(--muted-foreground)' }}
      role="status"
    >
      <span
        aria-hidden="true"
        className="animate-pulse-dot w-1.5 h-1.5 rounded-full inline-block"
        style={{ background: 'var(--class-public)' }}
      />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Modal dialog                                                        */
/* ------------------------------------------------------------------ */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    // Focus the dialog for screen readers; return focus on unmount is left
    // to the browser since the trigger is usually still mounted.
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(24,24,27,0.45)' }} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative rounded-xl w-full overflow-hidden outline-none animate-scale-in"
        style={{
          maxWidth: wide ? '42rem' : '28rem',
          background: 'var(--card)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <h2 className="font-semibold" style={{ fontSize: 'var(--text-section-title)', color: 'var(--foreground)' }}>
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5" style={{ fontSize: 'var(--text-secondary)', color: 'var(--muted-foreground)' }}>
                {subtitle}
              </p>
            )}
          </div>
          <IconButton label={`Close ${title}`} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </IconButton>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
