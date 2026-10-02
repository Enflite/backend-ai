/** Generic colored pill for statuses, kinds, and other small labels. */
export default function StatusBadge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap"
      style={{ color, background: bg }}
    >
      {label}
    </span>
  );
}
