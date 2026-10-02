// Deadline arithmetic. The deadline is the product, so this module is pure,
// has no I/O, and takes "now" as an argument everywhere.
//
// Rules, stated once:
//  * A deadline is an absolute instant. PayPal sends UTC ("...Z"). A timestamp
//    with no zone designator is ambiguous and is REJECTED, never guessed.
//  * now >= due means expired. The last valid millisecond is due - 1.
//  * "Due today" is a calendar question answered in the SELLER'S timezone, not
//    in UTC and not by dividing milliseconds by 86 400 000 (DST days are 23 or
//    25 hours long).

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export function parseInstant(v) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new RangeError('invalid Date');
    return v.getTime();
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError('non-finite timestamp');
    return v;
  }
  if (typeof v !== 'string' || !ZONED.test(v)) {
    throw new RangeError(`timestamp must be ISO-8601 with an explicit zone (Z or +hh:mm): ${JSON.stringify(v)}`);
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new RangeError(`unparseable timestamp: ${v}`);
  return ms;
}

const fmtCache = new Map();
function dateParts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o; // {year, month, day, hour, minute, second}
}

/** Civil calendar date of an instant in a zone. */
export function localDate(ms, tz) {
  const { year, month, day } = dateParts(ms, tz);
  return { y: year, m: month, d: day };
}

/** Whole calendar days from a's local date to b's local date (negative if b is earlier). */
export function calendarDaysBetween(aMs, bMs, tz) {
  const a = localDate(aMs, tz), b = localDate(bMs, tz);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY);
}

/** "2026-10-05 17:30 CDT" style label in the seller's zone. */
export function formatLocal(ms, tz) {
  const p = dateParts(ms, tz);
  const z = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName')?.value ?? tz;
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${z}`;
}

export const BANDS = ['expired', 'critical', 'urgent', 'soon', 'ok'];
export const CRITICAL_MS = 6 * HOUR;
export const URGENT_MS = 24 * HOUR;
export const SOON_MS = 72 * HOUR;

export function bandFor(remainingMs) {
  if (remainingMs <= 0) return 'expired';
  if (remainingMs < CRITICAL_MS) return 'critical';
  if (remainingMs < URGENT_MS) return 'urgent';
  if (remainingMs < SOON_MS) return 'soon';
  return 'ok';
}

/** Hours-minutes-seconds split of a non-negative duration. */
export function splitDuration(ms) {
  const n = Math.max(0, Math.floor(ms / SEC));
  return { days: Math.floor(n / 86400), hours: Math.floor((n % 86400) / 3600), minutes: Math.floor((n % 3600) / 60), seconds: n % 60 };
}

/**
 * Everything the UI and the guard need to know about one deadline.
 * @param {number|string|Date} now
 * @param {number|string|Date} due
 * @param {{tz:string, openedAt?:number|string|Date}} opts
 */
export function assess(now, due, { tz, openedAt } = {}) {
  if (!tz) throw new TypeError('assess: tz (seller IANA timezone) is required');
  const n = parseInstant(now), d = parseInstant(due);
  const remainingMs = d - n;
  const expired = remainingMs <= 0;
  const days = calendarDaysBetween(n, d, tz);
  const o = openedAt == null ? null : parseInstant(openedAt);
  const windowMs = o == null ? null : d - o;
  return {
    due_ms: d,
    remaining_ms: remainingMs,
    expired,
    overdue_by_ms: expired ? -remainingMs : 0,
    band: bandFor(remainingMs),
    calendar_days_until: days,
    due_today: !expired && days === 0,
    due_tomorrow: !expired && days === 1,
    due_local: formatLocal(d, tz),
    now_local: formatLocal(n, tz),
    window_ms: windowMs,
    elapsed_fraction: windowMs && windowMs > 0 ? Math.min(1, Math.max(0, (n - o) / windowMs)) : null,
    parts: splitDuration(remainingMs),
  };
}

/**
 * The last moment a HUMAN is allowed to sit on a dispute before the guard files
 * the best honest response itself ("hand-over point").
 *   buffer = 10% of the response window, clamped to [1 h, 12 h]; 6 h if the window is unknown.
 *   If the dispute only reached a person late (less than 2 x buffer left when it was
 *   escalated), the buffer shrinks to half of what was left, but never below 1 h, so a
 *   late arrival still gets a human window instead of being auto-filed on the spot.
 */
export function humanDeadline(openedAt, due, escalatedAt = null) {
  const d = parseInstant(due);
  const o = openedAt == null ? null : parseInstant(openedAt);
  const window = o == null ? null : d - o;
  let buffer = window == null || window <= 0 ? 6 * HOUR : Math.min(12 * HOUR, Math.max(1 * HOUR, Math.round(window * 0.1)));
  if (escalatedAt != null) {
    const left = d - parseInstant(escalatedAt);
    if (left < 2 * buffer) buffer = Math.max(1 * HOUR, Math.floor(left / 2));
  }
  return { at_ms: d - buffer, buffer_ms: buffer };
}
