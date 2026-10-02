/**
 * hooks/useTheme.ts — explicit dark-first theme control.
 *
 * The theme is an explicit user choice persisted to localStorage
 * (`enflite-theme`: 'dark' | 'light'); there is deliberately no
 * prefers-color-scheme auto-switching. Dark is the default, applied
 * before first paint by the inline script in index.html so there is no
 * light-to-dark flash.
 *
 * Pure helpers are exported for unit tests; the hook takes an injected
 * environment so tests don't need a DOM.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemeName = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'enflite-theme';
export const DEFAULT_THEME: ThemeName = 'dark';

/** Normalize a stored value; anything unknown falls back to dark. */
export function parseTheme(value: string | null | undefined): ThemeName {
  return value === 'light' ? 'light' : 'dark';
}

export function toggleThemeName(current: ThemeName): ThemeName {
  return current === 'dark' ? 'light' : 'dark';
}

/** Browser surface the theme logic runs against (injectable for tests). */
export interface ThemeEnvironment {
  readStored: () => string | null;
  writeStored: (theme: ThemeName) => void;
  applyTheme: (theme: ThemeName) => void;
}

export const browserThemeEnvironment: ThemeEnvironment = {
  readStored: () => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  writeStored: (theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* storage unavailable (private mode etc.) — theme still applies */
    }
  },
  applyTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
  },
};

/**
 * Current theme + toggle. Applies `data-theme` on <html> and persists
 * every change.
 */
export function useTheme(env: ThemeEnvironment = browserThemeEnvironment): [ThemeName, () => void] {
  const [theme, setTheme] = useState<ThemeName>(() => parseTheme(env.readStored()));

  useEffect(() => {
    env.applyTheme(theme);
    env.writeStored(theme);
  }, [theme, env]);

  const toggle = useCallback(() => setTheme(toggleThemeName), []);
  return [theme, toggle];
}
