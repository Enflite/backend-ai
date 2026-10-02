/**
 * studio/components/StudioIcons.tsx — builder/run icon set in the Relay
 * register: minimal strokes, 1.5px, round caps, sized by the `size` prop.
 */
function Base({ size = 16, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconPlay({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M4.5 2.8v10.4c0 .4.4.7.8.5l7.6-5.2c.3-.2.3-.7 0-.9L5.3 2.3c-.4-.2-.8 0-.8.5z" />
    </Base>
  );
}

export function IconPlus({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M8 2.5v11M2.5 8h11" />
    </Base>
  );
}

export function IconX({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </Base>
  );
}

export function IconCheck({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M2.8 8.4l3.6 3.6 6.8-8" />
    </Base>
  );
}

export function IconChevronUp({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M3 10l5-5 5 5" />
    </Base>
  );
}

export function IconChevronDown({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M3 6l5 5 5-5" />
    </Base>
  );
}

export function IconCopy({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-1a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h1" />
    </Base>
  );
}

export function IconTrash({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M2.8 4h10.4M6.5 4V2.8c0-.3.2-.5.5-.5h2c.3 0 .5.2.5.5V4M4.3 4l.7 9.2c.1.7.6 1.1 1.2 1.1h3.6c.6 0 1.1-.4 1.2-1.1L11.7 4M6.8 7v4.2M9.2 7v4.2" />
    </Base>
  );
}

export function IconClock({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.4 1.6" />
    </Base>
  );
}

export function IconAlert({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M8 2L14.5 13.5h-13L8 2z" />
      <path d="M8 6.5v3.2" />
      <circle cx="8" cy="11.6" r="0.4" fill="currentColor" stroke="none" />
    </Base>
  );
}

export function IconLink({ size }: { size?: number }) {
  return (
    <Base size={size}>
      <path d="M6.5 9.5l3-3M7.8 4.7l1.6-1.6a2.4 2.4 0 013.4 3.4L11.2 8M8.2 11.3l-1.6 1.6a2.4 2.4 0 01-3.4-3.4L4.8 8" />
    </Base>
  );
}
