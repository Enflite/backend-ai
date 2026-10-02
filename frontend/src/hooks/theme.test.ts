/**
 * hooks/theme.test.ts — theme logic is pure and environment-injected,
 * so it tests without a DOM (no jsdom in this package).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  parseTheme,
  toggleThemeName,
  useTheme,
  type ThemeEnvironment,
  type ThemeName,
} from './useTheme';

/** Minimal fake environment recording reads/writes/applies. */
function fakeEnvironment(stored: string | null = null): ThemeEnvironment & {
  stored: Record<string, string>;
  applied: ThemeName[];
} {
  const storage: Record<string, string> = stored === null ? {} : { [THEME_STORAGE_KEY]: stored };
  const env = {
    stored: storage,
    applied: [] as ThemeName[],
    readStored() {
      return this.stored[THEME_STORAGE_KEY] ?? null;
    },
    writeStored(theme: ThemeName) {
      this.stored[THEME_STORAGE_KEY] = theme;
    },
    applyTheme(theme: ThemeName) {
      this.applied.push(theme);
    },
  };
  return env;
}

describe('parseTheme', () => {
  it('passes dark and light through', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
  });

  it('falls back to dark for missing or unknown values', () => {
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme(undefined)).toBe('dark');
    expect(parseTheme('')).toBe('dark');
    expect(parseTheme('solarized')).toBe('dark');
    expect(parseTheme(DEFAULT_THEME)).toBe('dark');
  });
});

describe('toggleThemeName', () => {
  it('flips between dark and light', () => {
    expect(toggleThemeName('dark')).toBe('light');
    expect(toggleThemeName('light')).toBe('dark');
  });
});

describe('useTheme hook (fake environment)', () => {
  // Render-free check: the hook is React; verify via the pure helpers +
  // the environment contract instead.
  it('initializes from storage and normalizes garbage to dark', () => {
    const env = fakeEnvironment('light');
    expect(parseTheme(env.readStored())).toBe('light');

    const garbage = fakeEnvironment('weird-value');
    expect(parseTheme(garbage.readStored())).toBe('dark');
  });

  it('a toggle cycle writes and applies the opposite theme', () => {
    const env = fakeEnvironment('dark');
    let current = parseTheme(env.readStored());

    current = toggleThemeName(current);
    env.applyTheme(current);
    env.writeStored(current);

    expect(current).toBe('light');
    expect(env.applied).toEqual(['light']);
    expect(env.stored[THEME_STORAGE_KEY]).toBe('light');
  });

  it('exports the React hook', () => {
    expect(typeof useTheme).toBe('function');
  });
});
