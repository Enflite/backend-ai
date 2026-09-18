import { describe, expect, it } from 'vitest';
import { isPlaceholderSecret, parseExpiresInToMs } from '../src/config.js';

describe('configuration primitives', () => {
  describe('parseExpiresInToMs', () => {
    it('parses jose-style durations', () => {
      expect(parseExpiresInToMs('15m')).toBe(15 * 60 * 1000);
      expect(parseExpiresInToMs('8h')).toBe(8 * 60 * 60 * 1000);
      expect(parseExpiresInToMs('7d')).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseExpiresInToMs('2w')).toBe(2 * 7 * 24 * 60 * 60 * 1000);
      expect(parseExpiresInToMs('30s')).toBe(30 * 1000);
      expect(parseExpiresInToMs('90')).toBe(90 * 1000);
      expect(parseExpiresInToMs(' 15m ')).toBe(15 * 60 * 1000);
    });

    it('rejects malformed durations at startup instead of breaking logins', () => {
      expect(() => parseExpiresInToMs('')).toThrow();
      expect(() => parseExpiresInToMs('soon')).toThrow();
      expect(() => parseExpiresInToMs('1y2d')).toThrow();
      expect(() => parseExpiresInToMs('-5m')).toThrow();
      expect(() => parseExpiresInToMs('15months')).toThrow();
    });
  });

  describe('isPlaceholderSecret', () => {
    it('flags documented placeholder secrets', () => {
      expect(isPlaceholderSecret('<redacted>')).toBe(true);
      expect(isPlaceholderSecret('dev-only-secret-do-not-use-in-production-min-32-chars')).toBe(true);
      expect(isPlaceholderSecret('  CHANGE-ME  ')).toBe(true);
    });

    it('accepts real secrets', () => {
      expect(isPlaceholderSecret('a'.repeat(64))).toBe(false);
      expect(isPlaceholderSecret('correct horse battery staple 32+ chars!!')).toBe(false);
    });
  });
});
