/**
 * providers/providerDisplay.ts — user-facing provider identity.
 *
 * Registry provider kinds ('ollama', 'vllm', 'openai-compatible', 'claude',
 * 'openai') are technical. Users see three providers: Enflite (everything
 * served from infrastructure the server controls — local Ollama first of
 * all), Claude, and OpenAI. "Ollama" never appears in user-facing strings;
 * it stays in code, config, and docs where technical accuracy matters.
 *
 * The data-residency note is the honesty mechanism for provider switching:
 * Enflite keeps prompts on the operator's infrastructure; Claude/OpenAI
 * send them to third-party clouds.
 */

/** User-facing provider groups. Exactly these three appear in the UI. */
export const PROVIDER_GROUPS = ['enflite', 'claude', 'openai'] as const;
export type ProviderGroup = (typeof PROVIDER_GROUPS)[number];

export interface ProviderGroupInfo {
  key: ProviderGroup;
  /** User-facing label. Never "Ollama". */
  label: string;
  tagline: string;
  dataResidency: 'local' | 'cloud';
  /** Short residency note shown next to the switcher. */
  residencyNote: string;
}

export const PROVIDER_GROUP_INFO: Record<ProviderGroup, ProviderGroupInfo> = {
  enflite: {
    key: 'enflite',
    label: 'Enflite',
    tagline: 'Private models on your infrastructure',
    dataResidency: 'local',
    residencyNote: 'Stays on your network',
  },
  claude: {
    key: 'claude',
    label: 'Claude',
    tagline: 'Anthropic cloud models',
    dataResidency: 'cloud',
    residencyNote: 'Sent to Anthropic',
  },
  openai: {
    key: 'openai',
    label: 'OpenAI',
    tagline: 'OpenAI cloud models',
    dataResidency: 'cloud',
    residencyNote: 'Sent to OpenAI',
  },
};

/**
 * Maps a registry provider kind to its user-facing group. Self-hosted
 * OpenAI-compatible endpoints (vLLM and generic) are operator-controlled
 * infrastructure, so they group under Enflite; the admin chose the
 * endpoint, and data residency follows it.
 */
export function providerGroupFor(providerKind: string): ProviderGroup {
  switch (providerKind) {
    case 'claude':
      return 'claude';
    case 'openai':
      return 'openai';
    case 'ollama':
    case 'vllm':
    case 'openai-compatible':
    default:
      return 'enflite';
  }
}

export function providerLabelFor(providerKind: string): string {
  return PROVIDER_GROUP_INFO[providerGroupFor(providerKind)].label;
}

export function isProviderGroup(value: string): value is ProviderGroup {
  return (PROVIDER_GROUPS as readonly string[]).includes(value);
}

/** Friendly display names for well-known models. Everything else falls
 * through to `prettifyModelName`. Add entries here when seeding new
 * well-known models — never show raw registry IDs in the UI. */
const KNOWN_DISPLAY_NAMES: Record<string, string> = {
  'llama3.1:8b': 'Enflite 8B',
  'qwen2.5vl:7b': 'Enflite Vision',
  'nomic-embed-text': 'Enflite Embeddings',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
};

/**
 * Deterministic fallback for unknown models: strip an `org/` prefix,
 * replace separators with spaces. E.g.
 * `meta-llama/Meta-Llama-3.1-8B-Instruct` -> `Meta Llama 3.1 8B Instruct`.
 */
export function prettifyModelName(raw: string): string {
  const withoutOrg = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return withoutOrg.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || raw;
}

/**
 * User-facing model name. Prefers the curated table (keyed by provider
 * model identifier, then registry name), then the prettifier. Never
 * returns a raw technical ID for a known model.
 */
export function displayNameForModel(model: { name: string; modelIdentifier: string }): string {
  return (
    KNOWN_DISPLAY_NAMES[model.modelIdentifier] ??
    KNOWN_DISPLAY_NAMES[model.name] ??
    prettifyModelName(model.modelIdentifier || model.name)
  );
}
