/**
 * cron.ts — dependency-free 5-field cron parser and next-run computation
 * (Schedules platform).
 *
 * Standard cron: `minute hour day-of-month month day-of-week`.
 * Supported per field: `*`, `*\/n`, `a-b`, `a-b\/n`, `n`, `n\/m`, lists
 * (`a,b,c`), and month / weekday names (JAN..DEC, MON..SUN; 7 == Sunday).
 *
 * Match semantics follow Vixie cron: when BOTH day-of-month and
 * day-of-week are restricted, a day matches when EITHER matches;
 * otherwise both must match (unrestricted fields always match).
 *
 * Timezones are IANA names validated via Intl. nextCronRun returns the
 * first occurrence strictly after `from`, or throws CronNoOccurrenceError
 * when nothing matches within 366 days (e.g. `30 2 30 2 *`).
 *
 * No external dependency on purpose: deterministic, offline, and fully
 * testable with a fixed clock. VALIDATED IN CI (unit tests).
 */

export class CronParseError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(message);
    this.name = 'CronParseError';
  }
}

export class CronNoOccurrenceError extends Error {
  constructor(public readonly expression: string) {
    super(`cron expression has no occurrence within 366 days: ${expression}`);
    this.name = 'CronNoOccurrenceError';
  }
}

export interface CronFields {
  /** The raw expression these fields were parsed from. */
  expression: string;
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the day-of-month field was restricted (not `*`). */
  dayOfMonthRestricted: boolean;
  /** True when the day-of-week field was restricted (not `*`). */
  dayOfWeekRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface FieldSpec {
  min: number;
  max: number;
  names?: Record<string, number>;
  /** Map an alias value into range (e.g. 7 -> 0 for Sunday). */
  normalize?: (value: number) => number;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12, names: MONTH_NAMES }, // month
  { min: 0, max: 6, names: DOW_NAMES, normalize: (v) => (v === 7 ? 0 : v) }, // day of week
];

function parseToken(
  token: string,
  spec: FieldSpec,
  expression: string,
): number {
  const lowered = token.toLowerCase();
  if (spec.names && lowered in spec.names) return spec.names[lowered]!;
  const value = Number(token);
  if (!Number.isInteger(value)) {
    throw new CronParseError(
      `invalid cron token "${token}" (expected a number${spec.names ? ' or name' : ''})`,
      expression,
    );
  }
  const normalized = spec.normalize ? spec.normalize(value) : value;
  if (normalized < spec.min || normalized > spec.max) {
    throw new CronParseError(
      `cron value ${value} out of range ${spec.min}-${spec.max}`,
      expression,
    );
  }
  return normalized;
}

function expandRange(
  start: number,
  end: number,
  step: number,
  spec: FieldSpec,
  expression: string,
): Set<number> {
  if (start > end) {
    throw new CronParseError(
      `cron range ${start}-${end} is inverted`,
      expression,
    );
  }
  if (step < 1) {
    throw new CronParseError(`cron step must be >= 1`, expression);
  }
  const values = new Set<number>();
  for (let value = start; value <= end; value += step) {
    values.add(value);
  }
  return values;
}

function parseField(
  raw: string,
  spec: FieldSpec,
  expression: string,
): { values: Set<number>; restricted: boolean } {
  if (raw === '*') {
    const values = new Set<number>();
    for (let value = spec.min; value <= spec.max; value++) values.add(value);
    return { values, restricted: false };
  }
  const values = new Set<number>();
  for (const item of raw.split(',')) {
    if (item.length === 0) {
      throw new CronParseError(`empty cron list item`, expression);
    }
    const [rangePart, stepPart] = item.split('/');
    if (stepPart !== undefined && stepPart.length === 0) {
      throw new CronParseError(`empty cron step in "${item}"`, expression);
    }
    const step = stepPart === undefined ? 1 : parseToken(stepPart, { min: 1, max: 9999 }, expression);
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-');
      if (b === undefined || b.length === 0) {
        throw new CronParseError(`invalid cron range "${item}"`, expression);
      }
      start = parseToken(a!, spec, expression);
      end = parseToken(b, spec, expression);
    } else {
      start = parseToken(rangePart!, spec, expression);
      // A bare `n` or `n/step` spans n..max (POSIX `n/step` behavior).
      end = stepPart === undefined ? start : spec.max;
    }
    for (const value of expandRange(start, end, step, spec, expression)) {
      values.add(value);
    }
  }
  return { values, restricted: true };
}

/** Parse a 5-field cron expression; throws CronParseError on any problem. */
export function parseCronExpression(expression: string): CronFields {
  const trimmed = expression.trim().replace(/\s+/g, ' ');
  const parts = trimmed.split(' ');
  if (parts.length !== 5) {
    throw new CronParseError(
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
      expression,
    );
  }
  const [minute, hour, dom, month, dow] = parts.map((part, index) =>
    parseField(part!, FIELD_SPECS[index]!, expression),
  );
  return {
    expression: trimmed,
    minute: minute!.values,
    hour: hour!.values,
    dayOfMonth: dom!.values,
    month: month!.values,
    dayOfWeek: dow!.values,
    dayOfMonthRestricted: dom!.restricted,
    dayOfWeekRestricted: dow!.restricted,
  };
}

/** True when the expression parses (no occurrence check). */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Timezone-aware next-run computation
// ---------------------------------------------------------------------------

/** True when `timeZone` is a valid IANA name (Intl throws RangeError if not). */
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
}

const WEEKDAY_TO_NUMBER: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function makePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });
}

function partsInTimezone(
  date: Date,
  formatter: Intl.DateTimeFormat,
): TzParts {
  const bag: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    bag[part.type] = part.value;
  }
  // hour12:false can emit hour "24" at midnight in some ICU versions.
  let hour = Number(bag['hour']);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag['year']),
    month: Number(bag['month']),
    day: Number(bag['day']),
    hour,
    minute: Number(bag['minute']),
    weekday: WEEKDAY_TO_NUMBER[bag['weekday']!] ?? 0,
  };
}

/**
 * Convert wall-clock parts in `timeZone` back to a UTC instant.
 * Uses the standard fixed-point trick; callers verify the round trip.
 */
function wallPartsToUtc(parts: TzParts, timeZone: string): Date {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const formatter = makePartsFormatter(timeZone);
  const probe = partsInTimezone(new Date(asUtc), formatter);
  const probeAsUtc = Date.UTC(probe.year, probe.month - 1, probe.day, probe.hour, probe.minute);
  return new Date(asUtc - (probeAsUtc - asUtc));
}

function matchesCron(fields: CronFields, parts: TzParts): boolean {
  if (!fields.minute.has(parts.minute)) return false;
  if (!fields.hour.has(parts.hour)) return false;
  if (!fields.month.has(parts.month)) return false;
  const domMatch = fields.dayOfMonth.has(parts.day);
  const dowMatch = fields.dayOfWeek.has(parts.weekday);
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/** Maximum forward scan for the next occurrence (a full leap year + margin). */
export const CRON_SCAN_LIMIT_MS = 366 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

/**
 * First cron occurrence strictly after `from`, in `timeZone`.
 * Throws CronNoOccurrenceError when nothing matches within 366 days.
 * Pure function of (fields, from, timeZone) — deterministic under a fixed
 * clock, which is what the tests rely on.
 */
export function nextCronRun(
  fields: CronFields,
  from: Date,
  timeZone: string,
): Date {
  const formatter = makePartsFormatter(timeZone);
  const cap = from.getTime() + CRON_SCAN_LIMIT_MS;
  // Start at the next whole minute strictly after `from`.
  let cursor = from.getTime() - (from.getTime() % MINUTE_MS) + MINUTE_MS;
  while (cursor <= cap) {
    const parts = partsInTimezone(new Date(cursor), formatter);
    if (matchesCron(fields, parts)) {
      const utc = wallPartsToUtc(parts, timeZone);
      // Round-trip check: DST gaps produce wall times that never existed.
      const check = partsInTimezone(utc, formatter);
      const sameWall =
        check.year === parts.year &&
        check.month === parts.month &&
        check.day === parts.day &&
        check.hour === parts.hour &&
        check.minute === parts.minute;
      if (sameWall && utc.getTime() > from.getTime()) return utc;
    }
    cursor += MINUTE_MS;
  }
  throw new CronNoOccurrenceError(fields.expression);
}
