/** Board view placeholder — the kanban board build fills this in. */
export default function BoardView() {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>Board</h1>
      <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
        The kanban board for SyteLine task runs and form customizations is under construction.
      </p>
    </div>
  );
}
