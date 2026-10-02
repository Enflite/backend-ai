/**
 * studio/components/StudioEmpty.tsx — designed honest empty slot for the
 * studio, in the style-guide's "inviting empty slot" register: hairline
 * border, muted icon, plain copy, optional action.
 */
import type { ReactNode } from 'react';

export function StudioEmptyIcon({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center rounded-lg"
      style={{
        width: 44,
        height: 44,
        border: '1px solid var(--border)',
        background: 'var(--secondary)',
        color: 'var(--muted-foreground)',
      }}
    >
      {children}
    </span>
  );
}

export default function StudioEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="rounded-lg px-6 py-12 text-center"
      style={{ border: '1px dashed var(--border-strong)', background: 'var(--card)' }}
    >
      {icon}
      <h2 className="mt-4 font-semibold" style={{ fontSize: 'var(--text-section-title)', color: 'var(--foreground)' }}>
        {title}
      </h2>
      <p
        className="mt-1.5 mx-auto max-w-md"
        style={{ fontSize: 'var(--text-secondary)', color: 'var(--muted-foreground)', lineHeight: 'var(--leading-relaxed)' }}
      >
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Shared stroke icons in the Relay register (18px, ~1.5px stroke). */
export function IconBolt() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 1.5L3 9h3.5L7 14.5 13 6.5H9.5L8.5 1.5z" />
    </svg>
  );
}

export function IconPlug() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2v3.5M10 2v3.5M4 5.5h8v3a4 4 0 01-8 0v-3zM8 12.5V15" />
    </svg>
  );
}

export function IconTable() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5V13" />
    </svg>
  );
}

export function IconList() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <path d="M5.5 4h9M5.5 8h9M5.5 12h9" />
      <circle cx="2.75" cy="4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.75" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.75" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconGear() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75v1.9M8 12.35v1.9M1.75 8h1.9M12.35 8h1.9M3.6 3.6l1.35 1.35M11.05 11.05l1.35 1.35M12.4 3.6l-1.35 1.35M4.95 11.05L3.6 12.4" />
    </svg>
  );
}
