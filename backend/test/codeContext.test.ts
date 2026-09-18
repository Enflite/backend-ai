import { describe, expect, it } from 'vitest';
import { assembleCodeContext, normalizeCodeFiles } from '../src/chat/codeContext.js';

describe('normalizeCodeFiles', () => {
  it('accepts a well-formed batch', () => {
    const files = normalizeCodeFiles([{ path: 'a.ts', content: 'const x = 1;' }]);
    expect(files).toEqual([{ path: 'a.ts', content: 'const x = 1;' }]);
  });
  it('rejects non-arrays and malformed entries', () => {
    expect(() => normalizeCodeFiles('nope')).toThrowError(/must be an array/);
    expect(() => normalizeCodeFiles([{ path: 'a.ts' }])).toThrowError(/requires string path and content/);
    expect(() => normalizeCodeFiles([null])).toThrowError(/must be an object/);
  });
  it('rejects batches over the file cap', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.ts`, content: 'x' }));
    expect(() => normalizeCodeFiles(many)).toThrowError(/at most 20 files/);
  });
  it('rejects a single file over the content cap', () => {
    expect(() => normalizeCodeFiles([{ path: 'big.ts', content: 'x'.repeat(200_001) }])).toThrowError(/exceeds 200000/);
  });
});

describe('assembleCodeContext', () => {
  it('labels every file with its exact path', () => {
    const { context, filesIncluded, dropped, truncated } = assembleCodeContext([
      { path: 'backend/src/a.ts', content: 'export const a = 1;' },
      { path: 'backend/src/b.ts', content: 'export const b = 2;' },
    ]);
    expect(filesIncluded).toEqual(['backend/src/a.ts', 'backend/src/b.ts']);
    expect(dropped).toEqual([]);
    expect(truncated).toBe(false);
    expect(context).toContain('--- REPO FILE: backend/src/a.ts ---');
    expect(context).toContain('--- REPO FILE: backend/src/b.ts ---');
    expect(context).toContain('export const a = 1;');
  });

  it('truncates files over the per-file budget with an explicit marker', () => {
    const { context, truncated } = assembleCodeContext(
      [{ path: 'big.ts', content: 'x'.repeat(5000) }],
      { maxCharsPerFile: 100 }
    );
    expect(truncated).toBe(true);
    expect(context).toContain('(truncated)');
    expect(context).toContain('per-file budget of 100 chars');
  });

  it('drops files past the total budget with a reason', () => {
    const { filesIncluded, dropped, truncated } = assembleCodeContext(
      [
        { path: 'a.ts', content: 'x'.repeat(100) },
        { path: 'b.ts', content: 'y'.repeat(100) },
      ],
      { maxTotalChars: 150 }
    );
    expect(filesIncluded).toEqual(['a.ts']);
    expect(dropped).toEqual([{ path: 'b.ts', reason: expect.stringContaining('total context budget') }]);
    expect(truncated).toBe(true);
  });

  it('drops unsafe paths instead of echoing them', () => {
    const { filesIncluded, dropped } = assembleCodeContext([
      { path: '../../etc/passwd', content: 'x' },
      { path: '/absolute/path.ts', content: 'x' },
      { path: 'ok.ts', content: 'x' },
    ]);
    expect(filesIncluded).toEqual(['ok.ts']);
    expect(dropped.map((d) => d.path)).toEqual(['../../etc/passwd', '/absolute/path.ts']);
  });

  it('never invents content: output contains only what was supplied', () => {
    const { context } = assembleCodeContext([{ path: 'real.ts', content: 'const real = true;' }]);
    expect(context).toContain('const real = true;');
    expect(context).not.toContain('imaginary');
  });
});
