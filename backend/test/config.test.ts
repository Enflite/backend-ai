import { describe, expect, it } from 'vitest';
import { config, isPlaceholderSecret, isValidCorsOrigin, parseExpiresInToMs } from '../src/config.js';

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

    it('rejects zero durations so tokens do not expire immediately', () => {
      expect(() => parseExpiresInToMs('0')).toThrow();
      expect(() => parseExpiresInToMs('0s')).toThrow();
      expect(() => parseExpiresInToMs('0m')).toThrow();
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

  describe('isValidCorsOrigin', () => {
    it('accepts bare http(s) origins', () => {
      expect(isValidCorsOrigin('http://localhost:8443')).toBe(true);
      expect(isValidCorsOrigin('https://app.example.com')).toBe(true);
      expect(isValidCorsOrigin('https://app.example.com:8443')).toBe(true);
      expect(isValidCorsOrigin('  https://app.example.com  ')).toBe(true);
    });

    it('rejects wildcards and the opaque null origin', () => {
      expect(isValidCorsOrigin('*')).toBe(false);
      expect(isValidCorsOrigin('null')).toBe(false);
      expect(isValidCorsOrigin('NULL')).toBe(false);
    });

    it('rejects non-origins: paths, schemes, and garbage', () => {
      expect(isValidCorsOrigin('')).toBe(false);
      expect(isValidCorsOrigin('not-a-url')).toBe(false);
      expect(isValidCorsOrigin('ftp://example.com')).toBe(false);
      expect(isValidCorsOrigin('https://app.example.com/callback')).toBe(false);
      expect(isValidCorsOrigin('https://app.example.com?x=1')).toBe(false);
    });
  });

  describe('AUDIT_FAIL_CLOSED', () => {
    it('defaults to fail-closed only in production', () => {
      // test/setup.ts pins NODE_ENV=test, so the flag must default to false
      // here; in production it defaults to true without any env override.
      expect(process.env.NODE_ENV).toBe('test');
      expect(config.AUDIT_FAIL_CLOSED).toBe(false);
    });
  });
});
