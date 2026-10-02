/**
 * cron.test.ts — 5-field cron parser + timezone-aware next-run (Schedules).
 *
 * Pure functions of (expression, from, timeZone): deterministic under a
 * fixed clock. VALIDATED IN CI.
 */
import { describe, expect, it } from 'vitest';
import {
  CronNoOccurrenceError,
  CronParseError,
  isValidCronExpression,
  isValidTimezone,
  nextCronRun,
  parseCronExpression,
} from '../src/schedules/cron.js';

const utc = (iso: string): Date => new Date(iso);

describe('parseCronExpression', () => {
  it('parses stars and steps', () => {
    const fields = parseCronExpression('*/15 9-17 * * 1-5');
    expect([...fields.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...fields.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(fields.dayOfWeekRestricted).toBe(true);
    expect(fields.dayOfMonthRestricted).toBe(false);
  });

  it('parses lists and names', () => {
    const fields = parseCronExpression('0 0 1 JAN,MAR Mon');
    expect(fields.month.has(1)).toBe(true);
    expect(fields.month.has(3)).toBe(true);
    expect(fields.dayOfWeek.has(1)).toBe(true);
  });

  it('treats 7 as Sunday', () => {
    const fields = parseCronExpression('0 0 * * 7');
    expect(fields.dayOfWeek.has(0)).toBe(true);
    expect(fields.dayOfWeek.has(7)).toBe(false);
  });

  it('parses n/step across the full range', () => {
    const fields = parseCronExpression('5/20 * * * *');
    expect([...fields.minute].sort((a, b) => a - b)).toEqual([5, 25, 45]);
  });

  it('rejects wrong field counts', () => {
    expect(() => parseCronExpression('* * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* * * * * *')).toThrow(CronParseError);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* 24 * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* * 0 * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* * * 13 *')).toThrow(CronParseError);
  });

  it('rejects bad tokens and inverted ranges', () => {
    expect(() => parseCronExpression('x * * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('5-2 * * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('*/0 * * * *')).toThrow(CronParseError);
  });

  it('isValidCronExpression is a safe predicate', () => {
    expect(isValidCronExpression('0 7 * * 1-5')).toBe(true);
    expect(isValidCronExpression('nope')).toBe(false);
  });

  it('isValidTimezone accepts IANA names only', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('nextCronRun', () => {
  it('finds the next weekday 7am in UTC', () => {
    // Friday 2026-10-02 12:00 UTC -> Monday 2026-10-05 07:00 UTC.
    const fields = parseCronExpression('0 7 * * 1-5');
    const next = nextCronRun(fields, utc('2026-10-02T12:00:00Z'), 'UTC');
    expect(next.toISOString()).toBe('2026-10-05T07:00:00.000Z');
  });

  it('is strictly after `from` (never returns `from` itself)', () => {
    const fields = parseCronExpression('0 12 * * *');
    const next = nextCronRun(fields, utc('2026-10-02T12:00:00Z'), 'UTC');
    expect(next.toISOString()).toBe('2026-10-03T12:00:00.000Z');
  });

  it('evaluates the expression in the schedule timezone', () => {
    // 9am America/Chicago on 2026-10-02 (CDT, UTC-5) == 14:00 UTC, same day.
    const fields = parseCronExpression('0 9 * * *');
    const next = nextCronRun(fields, utc('2026-10-02T12:00:00Z'), 'America/Chicago');
    expect(next.toISOString()).toBe('2026-10-02T14:00:00.000Z');
  });

  it('skips the spring-forward gap (02:30 never exists on 2026-03-08)', () => {
    const fields = parseCronExpression('30 2 * * *');
    const next = nextCronRun(fields, utc('2026-03-08T00:00:00Z'), 'America/Chicago');
    // 2026-03-09 02:30 CDT is UTC-5: 07:30 UTC.
    expect(next.toISOString()).toBe('2026-03-09T07:30:00.000Z');
  });

  it('fires inside the fall-back fold (01:30 occurs twice on 2026-11-01)', () => {
    const fields = parseCronExpression('30 1 1 11 *');
    const next = nextCronRun(fields, utc('2026-10-31T00:00:00Z'), 'America/Chicago');
    const iso = next.toISOString();
    expect(iso === '2026-11-01T06:30:00.000Z' || iso === '2026-11-01T07:30:00.000Z').toBe(true);
  });

  it('uses OR semantics when both dom and dow are restricted', () => {
    // 1st of month OR Sunday at midnight.
    const fields = parseCronExpression('0 0 1 * 0');
    // 2026-10-02 is a Friday; next Sunday is 2026-10-04.
    const next = nextCronRun(fields, utc('2026-10-02T12:00:00Z'), 'UTC');
    expect(next.toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });

  it('uses AND semantics when only dom is restricted', () => {
    // Midnight on the 1st (dow unrestricted).
    const fields = parseCronExpression('0 0 1 * *');
    const next = nextCronRun(fields, utc('2026-10-02T12:00:00Z'), 'UTC');
    expect(next.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('throws CronNoOccurrenceError for impossible schedules', () => {
    const fields = parseCronExpression('0 0 30 2 *');
    expect(() => nextCronRun(fields, utc('2026-10-02T12:00:00Z'), 'UTC')).toThrow(
      CronNoOccurrenceError,
    );
  });
});
