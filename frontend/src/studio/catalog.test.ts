/**
 * studio/catalog.test.ts — pure catalog helpers.
 */
import { describe, expect, it } from 'vitest';
import { groupActionsBySubstrate, substrateLabel } from './catalog';
import type { StudioAction } from './types';

function action(partial: Partial<StudioAction>): StudioAction {
  return {
    id: 'x',
    title: 'X',
    description: 'd',
    substrate: 'syteline',
    destructive: false,
    supported: true,
    ...partial,
  };
}

describe('groupActionsBySubstrate', () => {
  it('groups by substrate preserving first-seen order', () => {
    const groups = groupActionsBySubstrate([
      action({ id: 'a', substrate: 'syteline' }),
      action({ id: 'b', substrate: 'webhooks' }),
      action({ id: 'c', substrate: 'syteline' }),
    ]);
    expect(groups.map((g) => g.substrate)).toEqual(['syteline', 'webhooks']);
    expect(groups[0].actions.map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('buckets blank substrates as unknown', () => {
    const groups = groupActionsBySubstrate([action({ id: 'a', substrate: '' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].substrate).toBe('unknown');
  });
});

describe('substrateLabel', () => {
  it('title-cases substrate keys', () => {
    expect(substrateLabel('syteline')).toBe('Syteline');
    expect(substrateLabel('syte_line')).toBe('Syte Line');
    expect(substrateLabel('')).toBe('Unknown');
  });
});
