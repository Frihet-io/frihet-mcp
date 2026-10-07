/**
 * `Retry-After` parsing per RFC 9110 §10.2.3: either `delay-seconds`
 * (1*DIGIT) or an HTTP-date. Returns the wait in milliseconds, or `null` when
 * the value is absent or malformed so the caller falls back to its own
 * backoff — never NaN, never negative.
 *
 * Semantics:
 * - delay-seconds: strict non-negative integer digits only (no sign, decimal
 *   point, exponent or whitespace inside). Values too large to represent
 *   safely are clamped to MAX_SAFE_INTEGER ms, which always exceeds any retry
 *   budget and therefore defers instead of sleeping.
 * - HTTP-date: IMF-fixdate, obsolete RFC 850 and ANSI C asctime() forms, all
 *   read as GMT. The wait is `date - now`; a date already in the past means
 *   the server's embargo has expired, so the wait is 0 (not negative). Clock
 *   skew is NOT compensated: shortening the wait would retry earlier than the
 *   server asked, lengthening it would hide a valid answer.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAYS_SHORT = DAYS_LONG.map((d) => d.slice(0, 3));

const IMF_FIXDATE =
  /^([A-Z][a-z]{2}), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE =
  /^([A-Z][a-z]+day), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE =
  /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

function utcMs(
  year: number,
  monthName: string,
  day: number,
  h: number,
  m: number,
  s: number,
): number | null {
  const month = MONTHS.indexOf(monthName);
  if (month < 0 || h > 23 || m > 59 || s > 60) return null;
  const ms = Date.UTC(year, month, day, h, m, s);
  const check = new Date(ms);
  // Reject roll-over such as "31 Feb" that Date.UTC silently normalizes.
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month
    || check.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

function weekdayMatches(ms: number, name: string, list: string[]): boolean {
  // getUTCDay: 0 = Sunday; the lists start on Monday.
  return list[(new Date(ms).getUTCDay() + 6) % 7] === name;
}

function parseHttpDate(value: string): number | null {
  let m = IMF_FIXDATE.exec(value);
  if (m) {
    const ms = utcMs(+m[4], m[3], +m[2], +m[5], +m[6], +m[7]);
    return ms !== null && weekdayMatches(ms, m[1], DAYS_SHORT) ? ms : null;
  }
  m = RFC850_DATE.exec(value);
  if (m) {
    // RFC 9110 §5.6.7: a two-digit year more than 50 years ahead is the past century.
    const yy = +m[4];
    const nowYear = new Date().getUTCFullYear();
    let year = Math.floor(nowYear / 100) * 100 + yy;
    if (year > nowYear + 50) year -= 100;
    const ms = utcMs(year, m[3], +m[2], +m[5], +m[6], +m[7]);
    return ms !== null && weekdayMatches(ms, m[1], DAYS_LONG) ? ms : null;
  }
  m = ASCTIME_DATE.exec(value);
  if (m) {
    const ms = utcMs(+m[7], m[2], +m[3].trim(), +m[4], +m[5], +m[6]);
    return ms !== null && weekdayMatches(ms, m[1], DAYS_SHORT) ? ms : null;
  }
  return null;
}

export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === "") return null;

  if (/^\d+$/.test(v)) {
    const seconds = Number(v);
    if (!Number.isFinite(seconds) || seconds * 1000 > Number.MAX_SAFE_INTEGER) {
      return Number.MAX_SAFE_INTEGER;
    }
    return seconds * 1000;
  }

  const dateMs = parseHttpDate(v);
  if (dateMs === null) return null;
  return Math.max(0, dateMs - nowMs);
}
