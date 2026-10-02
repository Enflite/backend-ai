import { describe, expect, it } from 'vitest';
import { fuzzyScore, fuzzyScoreFields, rankFuzzy } from './fuzzy';

describe('fuzzyScore', () => {
  it('returns null when the query is not a subsequence of the target', () => {
    expect(fuzzyScore('xyz', 'abcdef')).toBeNull();
    expect(fuzzyScore('longer query than target', 'short')).toBeNull();
    expect(fuzzyScore('a', '')).toBeNull();
  });

  it('returns 0 for an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('   ', 'anything')).toBe(0);
  });

  it('ranks an exact match above all others', () => {
    expect(fuzzyScore('chat', 'chat')).toBe(Number.POSITIVE_INFINITY);
  });

  it('is case-insensitive', () => {
    const a = fuzzyScore('CHAT', 'chat');
    const b = fuzzyScore('chat', 'CHAT');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toBe(b);
  });

  it('ranks prefix matches above word-boundary and subsequence matches', () => {
    const prefix = fuzzyScore('boa', 'Board')!;
    const boundary = fuzzyScore('boa', 'Task board view')!;
    const subsequence = fuzzyScore('boa', 'Some big orange apple')!;
    expect(prefix).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(subsequence).not.toBeNull();
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(subsequence);
  });

  it('ranks consecutive runs above scattered matches', () => {
    const consecutive = fuzzyScore('task', 'task agents')!;
    const scattered = fuzzyScore('task', 'tire a skunk')!;
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('prefers shorter targets on ties', () => {
    const short = fuzzyScore('agent', 'Agent')!;
    const long = fuzzyScore('agent', 'Agent configuration panel')!;
    expect(short).toBeGreaterThan(long);
  });
});

describe('fuzzyScoreFields', () => {
  it('takes the best score across fields', () => {
    const best = fuzzyScoreFields('chat', ['zzz', 'Chat window'])!;
    const titleOnly = fuzzyScore('chat', 'Chat window')!;
    expect(best).toBe(titleOnly);
  });

  it('returns null when no field matches', () => {
    expect(fuzzyScoreFields('xyz', ['abc', 'def'])).toBeNull();
  });
});

describe('rankFuzzy', () => {
  const items = [
    { title: 'Some big orange apple' },
    { title: 'Task board view' },
    { title: 'Board' },
  ];

  it('returns all items for an empty query, in original order', () => {
    expect(rankFuzzy('', items, (i) => [i.title])).toEqual(items);
  });

  it('drops non-matches and orders prefix > word-boundary > subsequence', () => {
    const ranked = rankFuzzy('boa', items, (i) => [i.title]);
    expect(ranked.map((i) => i.title)).toEqual([
      'Board',
      'Task board view',
      'Some big orange apple',
    ]);
  });

  it('keeps original order for equal scores (stable)', () => {
    const dupes = [{ title: 'aa' }, { title: 'aa' }];
    const ranked = rankFuzzy('aa', dupes, (i) => [i.title]);
    expect(ranked).toEqual(dupes);
  });

  it('matches across multiple fields', () => {
    const ranked = rankFuzzy('wf', [{ title: 'Reports', keywords: 'workflows automation' }], (i) => [
      i.title,
      i.keywords,
    ]);
    expect(ranked).toHaveLength(1);
  });
});
