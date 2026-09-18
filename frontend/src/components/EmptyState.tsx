import type { Model } from '../types';

const SUGGESTIONS = [
  { label: 'Summarize a document', prompt: 'Can you summarize the key points from the attached procurement policy?' },
  { label: 'Draft a memo', prompt: 'Draft a memo announcing the new Q4 budget freeze to department heads.' },
  { label: 'Analyze data', prompt: 'Analyze this CSV and identify the top 5 cost drivers by department.' },
  { label: 'Review code', prompt: 'Review this Python function for security issues and suggest improvements.' },
];

interface EmptyStateProps {
  model: Model;
  onPrompt: (prompt: string) => void;
}

export default function EmptyState({ model, onPrompt }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-12 text-center">
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
        style={{ background: 'rgba(0,201,167,0.1)', border: '1px solid rgba(0,201,167,0.2)' }}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M14 2L17 10H25L19 15L21 23L14 18L7 23L9 15L3 10H11L14 2Z" fill="var(--accent)" opacity="0.8" />
        </svg>
      </div>

      <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--foreground)' }}>
        Private AI — Ready
      </h2>
      <p className="text-sm max-w-sm mb-1" style={{ color: 'var(--muted-foreground)' }}>
        Using <strong style={{ color: 'var(--foreground)' }}>{model.name}</strong> running on your internal infrastructure.
      </p>
      <p className="text-sm max-w-sm mb-8" style={{ color: 'var(--muted-foreground)' }}>
        No data leaves your environment. Supports up to{' '}
        <span className="font-medium" style={{ color: 'var(--foreground)' }}>{model.classificationMax}</span> classification.
      </p>

      <div className="grid grid-cols-2 gap-2 w-full max-w-lg">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onPrompt(s.prompt)}
            className="text-left px-3 py-2.5 rounded-lg text-sm hover:bg-secondary"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              color: 'var(--secondary-foreground)',
            }}
          >
            <p className="font-medium text-sm mb-0.5" style={{ color: 'var(--foreground)' }}>{s.label}</p>
            <p className="text-xs leading-snug" style={{ color: 'var(--muted-foreground)' }}>
              {s.prompt.slice(0, 60)}…
            </p>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-4 mt-8">
        <SecurityBadge icon="🔒" label="TLS in transit" />
        <SecurityBadge icon="🏠" label="Self-hosted" />
      </div>
    </div>
  );
}

function SecurityBadge({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted-foreground)' }}>
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}
