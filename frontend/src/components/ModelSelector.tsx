import type { Model } from '../types';

const CLASSIFICATION_ORDER: Record<string, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, PROPRIETARY: 3, CUI: 4 };
const CLASSIFICATION_COLOR: Record<string, string> = {
  PUBLIC: '#22c55e',
  INTERNAL: '#3b82f6',
  CONFIDENTIAL: '#f59e0b',
  PROPRIETARY: '#ef4444',
  CUI: '#a855f7',
};

interface ModelSelectorProps {
  models: Model[];
  selected: Model;
  onSelect: (model: Model) => void;
  onClose: () => void;
}

export default function ModelSelector({ models, selected, onSelect, onClose }: ModelSelectorProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.5)' }} />
      <div
        className="relative rounded-xl w-full max-w-md mx-4 overflow-hidden"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Select Model</h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>All models run on internal infrastructure</p>
        </div>
        <div className="p-2">
          {models.map((model) => {
            const unavailable = !model.enabled;
            return (
              <button
                key={model.id}
                disabled={unavailable}
                onClick={() => { onSelect(model); onClose(); }}
                className="w-full flex items-start gap-3 p-3 rounded-lg hover:bg-secondary text-left disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: selected.id === model.id ? 'var(--secondary)' : 'transparent' }}
                title={unavailable ? 'This model is disabled by the server' : undefined}
              >
                <div className="mt-0.5">
                  <div
                    className="w-2 h-2 rounded-full mt-1"
                    style={{ background: unavailable ? '#6b7280' : model.provider === 'local' ? 'var(--accent)' : '#f59e0b' }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>{model.name}</span>
                    {unavailable ? (
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#6b728020', color: '#9ca3af' }}>Disabled</span>
                    ) : selected.id === model.id && (
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,201,167,0.15)', color: 'var(--accent)' }}>Active</span>
                    )}
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>{model.description}</p>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    <span>{(model.contextLength / 1000).toFixed(0)}K context</span>
                  </span>
                  <span className="flex items-center gap-1 text-xs">
                    <span
                      className="px-1.5 py-0.5 rounded text-xs font-medium"
                      style={{
                        background: CLASSIFICATION_COLOR[model.classificationMax] + '20',
                        color: CLASSIFICATION_COLOR[model.classificationMax],
                      }}
                    >
                      Up to {model.classificationMax}
                    </span>
                  </span>
                </div>
              </div>
            </button>
            );
          })}
        </div>
        <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted-foreground)' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            Provider endpoints and credentials are controlled by the server.
          </div>
        </div>
      </div>
    </div>
  );
}
