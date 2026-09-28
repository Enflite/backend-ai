import type { ProviderGroup, ProviderInfo } from '../types';

interface ProviderSwitcherProps {
  providers: ProviderInfo[];
  active: ProviderGroup;
  onSelect: (group: ProviderGroup) => void;
}

/**
 * One-tap provider switcher: Enflite | Claude | OpenAI.
 *
 * Sits immediately next to the model picker. The active provider is always
 * obvious (accent fill); unconfigured cloud providers render disabled with
 * an admin-key hint instead of a dead button; data residency is visible on
 * every segment (Local vs Cloud).
 */
export default function ProviderSwitcher({ providers, active, onSelect }: ProviderSwitcherProps) {
  if (providers.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="AI provider"
      className="flex items-center rounded-lg p-0.5"
      style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}
    >
      {providers.map((provider) => {
        const isActive = provider.key === active;
        const available = provider.enabled && provider.configured;
        const title = available
          ? `${provider.label} — ${provider.description}`
          : `${provider.label} — ${provider.hint ?? 'Not available'}`;
        return (
          <button
            key={provider.key}
            type="button"
            disabled={!available}
            onClick={() => onSelect(provider.key)}
            title={title}
            aria-pressed={isActive}
            className="flex flex-col items-center px-2.5 py-1 rounded-md text-xs leading-tight disabled:opacity-45 disabled:cursor-not-allowed"
            style={{
              background: isActive ? 'var(--accent)' : 'transparent',
              color: isActive ? 'var(--accent-foreground)' : 'var(--muted-foreground)',
              fontWeight: isActive ? 600 : 400,
              minWidth: 64,
            }}
          >
            <span>{provider.label}</span>
            <span
              className="text-[9px] uppercase tracking-wide"
              style={{ color: isActive ? 'var(--accent-foreground)' : 'var(--muted-foreground)', opacity: 0.75 }}
            >
              {provider.residency === 'local' ? 'Local' : 'Cloud'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
