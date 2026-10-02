/**
 * studio/catalog.ts — pure helpers over the action catalog (testable).
 */
import type { StudioAction } from './types';

/** Group actions by substrate, preserving first-seen substrate order. */
export function groupActionsBySubstrate(actions: StudioAction[]): { substrate: string; actions: StudioAction[] }[] {
  const groups = new Map<string, StudioAction[]>();
  for (const action of actions) {
    const key = action.substrate || 'unknown';
    const list = groups.get(key);
    if (list) list.push(action);
    else groups.set(key, [action]);
  }
  return [...groups.entries()].map(([substrate, list]) => ({ substrate, actions: list }));
}

/** Display label for a substrate key: 'syteLine' → 'SyteLine', etc. */
export function substrateLabel(substrate: string): string {
  if (!substrate) return 'Unknown';
  return substrate
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
