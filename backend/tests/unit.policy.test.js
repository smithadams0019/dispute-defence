import test from 'node:test';
import assert from 'node:assert/strict';
import { guardAction, routeByStrength, strengthBand, FILE_AT, STRONG_AT } from '../src/policy.js';
import { HOUR, DAY, humanDeadline } from '../src/deadline.js';

const due = Date.parse('2026-10-11T00:00:00Z');
const base = (state, extra = {}) => ({ state, due_at: new Date(due).toISOString(), opened_at: '2026-10-01T00:00:00Z', ...extra });

test('terminal states never act', () => {
  for (const s of ['FILED', 'ACCEPTED', 'RESOLVED', 'MISSED']) {
    assert.equal(guardAction(due + 5 * DAY, base(s)).action, 'none');
  }
});

test('anything unfiled at or after due is marked missed; 1 ms before is not', () => {
  for (const s of ['NEW', 'ANALYSED', 'ESCALATED']) {
    assert.equal(guardAction(due, base(s)).action, 'mark_missed', s);
    assert.notEqual(guardAction(due - 1, base(s)).action, 'mark_missed', s);
  }
});

test('NEW runs the agent; ANALYSED files', () => {
  assert.equal(guardAction(due - 5 * DAY, base('NEW')).action, 'run_agent');
  assert.equal(guardAction(due - 5 * DAY, base('ANALYSED')).action, 'file');
});

test('ESCALATED: waits, nudges inside 24h, force-files at the hand-over point', () => {
  const hd = humanDeadline('2026-10-01T00:00:00Z', due).at_ms; // due - 12h
  assert.equal(guardAction(due - 5 * DAY, base('ESCALATED')).action, 'none');
  assert.equal(guardAction(due - 24 * HOUR, base('ESCALATED')).action, 'nudge_human');
  assert.equal(guardAction(due - 24 * HOUR, base('ESCALATED', { nudged: true })).action, 'none');
  assert.equal(guardAction(hd - 1, base('ESCALATED', { nudged: true })).action, 'none');
  assert.equal(guardAction(hd, base('ESCALATED', { nudged: true })).action, 'file_best_effort', 'boundary: at the hand-over instant the guard acts');
  assert.equal(guardAction(due - 1, base('ESCALATED')).action, 'file_best_effort');
});

test('short window: 3h40m left, 1h hand-over floor', () => {
  const rec = { state: 'ESCALATED', due_at: new Date(due).toISOString(), opened_at: new Date(due - 10 * DAY).toISOString() };
  // 10-day window => 12h buffer, so with only 3h40 left the hand-over point is already past: guard files now.
  assert.equal(guardAction(due - 3 * HOUR - 40 * 60000, rec).action, 'file_best_effort');
});

test('routeByStrength thresholds', () => {
  assert.equal(routeByStrength(FILE_AT).action, 'auto_file');
  assert.equal(routeByStrength(FILE_AT - 1).action, 'human_review');
  assert.equal(routeByStrength(100, 'accept').action, 'human_review', 'accept recommendations always need a person');
  assert.equal(strengthBand(STRONG_AT), 'strong');
  assert.equal(strengthBand(STRONG_AT - 1), 'moderate');
  assert.equal(strengthBand(FILE_AT - 1), 'weak');
});
