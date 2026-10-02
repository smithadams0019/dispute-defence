import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInstant, assess, bandFor, calendarDaysBetween, localDate, formatLocal, humanDeadline,
  HOUR, MIN, DAY, SEC, splitDuration,
} from '../src/deadline.js';

const T = (s) => Date.parse(s);

test('parseInstant accepts Z and offsets, rejects zoneless strings', () => {
  assert.equal(parseInstant('2026-10-05T07:00:00.000Z'), T('2026-10-05T07:00:00Z'));
  assert.equal(parseInstant('2026-10-05T02:00:00-05:00'), T('2026-10-05T07:00:00Z'));
  assert.equal(parseInstant('2026-10-05T12:30:00+0530'), T('2026-10-05T07:00:00Z'));
  assert.throws(() => parseInstant('2026-10-05T07:00:00'), /explicit zone/);
  assert.throws(() => parseInstant('2026-10-05'), /explicit zone/);
  assert.throws(() => parseInstant('not a date'), /explicit zone/);
  assert.throws(() => parseInstant(NaN), /non-finite/);
  assert.throws(() => parseInstant(undefined), /explicit zone/);
});

test('expiry boundary: now === due is expired, 1 ms earlier is not', () => {
  const due = '2026-10-05T07:00:00Z';
  const a = assess(T(due) - 1, due, { tz: 'UTC' });
  assert.equal(a.expired, false);
  assert.equal(a.remaining_ms, 1);
  assert.equal(a.band, 'critical');
  const b = assess(T(due), due, { tz: 'UTC' });
  assert.equal(b.expired, true);
  assert.equal(b.band, 'expired');
  assert.equal(b.due_today, false, 'an expired deadline is never "due today"');
  const c = assess(T(due) + 90 * MIN, due, { tz: 'UTC' });
  assert.equal(c.overdue_by_ms, 90 * MIN);
});

test('band thresholds: 6h / 24h / 72h edges', () => {
  assert.equal(bandFor(6 * HOUR - 1), 'critical');
  assert.equal(bandFor(6 * HOUR), 'urgent');
  assert.equal(bandFor(24 * HOUR - 1), 'urgent');
  assert.equal(bandFor(24 * HOUR), 'soon');
  assert.equal(bandFor(72 * HOUR - 1), 'soon');
  assert.equal(bandFor(72 * HOUR), 'ok');
  assert.equal(bandFor(0), 'expired');
  assert.equal(bandFor(-5), 'expired');
});

test('deadline TODAY: later today in the seller zone is due_today, not overdue', () => {
  // Seller in Chicago (CDT, UTC-5). now = 09:00 local, due = 23:59:59 local the same day.
  const now = '2026-10-05T14:00:00Z';          // 09:00 CDT
  const due = '2026-10-06T04:59:59Z';          // 23:59:59 CDT
  const a = assess(now, due, { tz: 'America/Chicago' });
  assert.equal(a.due_today, true);
  assert.equal(a.expired, false);
  assert.equal(a.calendar_days_until, 0);
  assert.match(a.due_local, /^2026-10-05 23:59 CDT$/);
  // The same pair seen from UTC is a DIFFERENT calendar day: tz matters.
  const u = assess(now, due, { tz: 'UTC' });
  assert.equal(u.calendar_days_until, 1);
  assert.equal(u.due_today, false);
  assert.equal(u.due_tomorrow, true);
});

test('deadline today, last millisecond vs first millisecond of next local day', () => {
  const tz = 'America/Chicago';
  const endOfDay = T('2026-10-06T04:59:59.999Z'); // 23:59:59.999 CDT on the 5th
  const now = T('2026-10-05T14:00:00Z');
  assert.equal(assess(now, endOfDay, { tz }).due_today, true);
  const midnight = endOfDay + 1;                   // 00:00:00.000 CDT on the 6th
  const b = assess(now, midnight, { tz });
  assert.equal(b.due_today, false);
  assert.equal(b.calendar_days_until, 1);
});

test('now exactly at local midnight: a deadline 1 s later is due today', () => {
  const tz = 'America/Chicago';
  const now = T('2026-10-05T05:00:00Z');           // 00:00:00 CDT on the 5th
  const due = now + SEC;
  const a = assess(now, due, { tz });
  assert.equal(a.due_today, true);
  assert.equal(a.calendar_days_until, 0);
});

test('half-hour and far-east offsets: Kolkata (+5:30) and Kiritimati (+14)', () => {
  const instant = T('2026-10-05T19:00:00Z');
  assert.deepEqual(localDate(instant, 'Asia/Kolkata'), { y: 2026, m: 10, d: 6 });      // 00:30 next day
  assert.deepEqual(localDate(instant, 'Pacific/Kiritimati'), { y: 2026, m: 10, d: 6 }); // 09:00 next day
  assert.deepEqual(localDate(instant, 'America/Los_Angeles'), { y: 2026, m: 10, d: 5 });
  assert.deepEqual(localDate(instant, 'Pacific/Pago_Pago'), { y: 2026, m: 10, d: 5 });  // 08:00 same day
  assert.match(formatLocal(instant, 'Asia/Kolkata'), /^2026-10-06 00:30 /);
});

test('DST fall-back day (US, 2026-11-01) is 25 h long: calendar days != ms / 24h', () => {
  const tz = 'America/New_York';
  // 2026-11-01 00:30 EDT -> 2026-11-02 00:30 EST is exactly 25 h but exactly 1 calendar day.
  const a = T('2026-11-01T04:30:00Z');   // 00:30 EDT
  const b = T('2026-11-02T05:30:00Z');   // 00:30 EST
  assert.equal(b - a, 25 * HOUR);
  assert.equal(calendarDaysBetween(a, b, tz), 1);
  // 23:30 EDT on Oct 31 (03:30Z Nov 1) to 23:30 EST on Nov 1 (04:30Z Nov 2): 25 h, still 1 day.
  assert.equal(calendarDaysBetween(T('2026-11-01T03:30:00Z'), T('2026-11-02T04:30:00Z'), tz), 1);
});

test('DST spring-forward day (US, 2026-03-08) is 23 h long', () => {
  const tz = 'America/New_York';
  const a = T('2026-03-08T05:30:00Z');   // 00:30 EST
  const b = T('2026-03-09T04:30:00Z');   // 00:30 EDT
  assert.equal(b - a, 23 * HOUR);
  assert.equal(calendarDaysBetween(a, b, tz), 1);
  // 22 h later is still the same calendar date for a deadline at 22:30 local on the 8th
  const due = T('2026-03-09T02:30:00Z'); // 22:30 EDT on the 8th
  assert.equal(assess(a, due, { tz }).due_today, true);
});

test('ambiguous local hour on fall-back: same wall-clock label, two distinct instants', () => {
  const tz = 'America/New_York';
  const first = T('2026-11-01T05:30:00Z');   // 01:30 EDT
  const second = T('2026-11-01T06:30:00Z');  // 01:30 EST
  assert.match(formatLocal(first, tz), /01:30 EDT$/);
  assert.match(formatLocal(second, tz), /01:30 EST$/);
  const a = assess(first, second, { tz });
  assert.equal(a.remaining_ms, HOUR, 'arithmetic uses instants, not wall-clock labels');
  assert.equal(a.due_today, true);
});

test('seller timezone is required; no silent UTC default', () => {
  assert.throws(() => assess(Date.now(), Date.now() + HOUR, {}), /tz/);
});

test('elapsed_fraction from window', () => {
  const opened = '2026-10-01T00:00:00Z', due = '2026-10-11T00:00:00Z';
  const a = assess('2026-10-06T00:00:00Z', due, { tz: 'UTC', openedAt: opened });
  assert.equal(a.window_ms, 10 * DAY);
  assert.equal(a.elapsed_fraction, 0.5);
  assert.equal(assess('2026-10-20T00:00:00Z', due, { tz: 'UTC', openedAt: opened }).elapsed_fraction, 1);
});

test('humanDeadline: 10% of window clamped to [1h,12h]', () => {
  const due = T('2026-10-11T00:00:00Z');
  // 10-day window -> 24h would be 10%, clamped to 12h
  assert.equal(humanDeadline('2026-10-01T00:00:00Z', due).buffer_ms, 12 * HOUR);
  // 5-hour window -> 30 min, clamped up to 1h
  assert.equal(humanDeadline(due - 5 * HOUR, due).buffer_ms, 1 * HOUR);
  // 60-hour window -> 6h exactly
  assert.equal(humanDeadline(due - 60 * HOUR, due).buffer_ms, 6 * HOUR);
  // unknown window -> 6h
  assert.equal(humanDeadline(null, due).buffer_ms, 6 * HOUR);
  assert.equal(humanDeadline(null, due).at_ms, due - 6 * HOUR);
});

test('humanDeadline: a late arrival still gets a human window (half of what was left, floor 1h)', () => {
  const due = T('2026-10-11T00:00:00Z');
  const opened = due - 10 * DAY;                  // normal buffer 12h
  // escalated with 3h40m left: 3h40m < 24h, so buffer = 1h50m; human has 1h50m
  const esc = due - (3 * HOUR + 40 * MIN);
  const hd = humanDeadline(opened, due, esc);
  assert.equal(hd.buffer_ms, 110 * MIN);
  assert.equal(hd.at_ms - esc, 110 * MIN);
  // escalated with 90 min left: half is 45 min, floored at 1h -> human gets 30 min
  const hd2 = humanDeadline(opened, due, due - 90 * MIN);
  assert.equal(hd2.buffer_ms, HOUR);
  assert.equal(hd2.at_ms, due - HOUR);
  // escalated with plenty of time: unchanged
  assert.equal(humanDeadline(opened, due, due - 5 * DAY).buffer_ms, 12 * HOUR);
  // escalated with exactly 2 x buffer left: unchanged (strict less-than)
  assert.equal(humanDeadline(opened, due, due - 24 * HOUR).buffer_ms, 12 * HOUR);
});

test('splitDuration', () => {
  assert.deepEqual(splitDuration(2 * DAY + 3 * HOUR + 4 * MIN + 5 * SEC + 999), { days: 2, hours: 3, minutes: 4, seconds: 5 });
  assert.deepEqual(splitDuration(-5000), { days: 0, hours: 0, minutes: 0, seconds: 0 });
});
