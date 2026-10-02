// The deadline guard: pure decision logic. Given "now" and one dispute record,
// say what the system must do next. No I/O.
import { parseInstant, humanDeadline, HOUR } from './deadline.js';

export const STATES = ['NEW', 'ANALYSED', 'ESCALATED', 'FILED', 'ACCEPTED', 'RESOLVED', 'MISSED'];
export const TERMINAL = new Set(['FILED', 'ACCEPTED', 'RESOLVED', 'MISSED']);

export const STRONG_AT = 70;
export const FILE_AT = 45; // below this the evidence is "genuinely weak" and a human decides

export function strengthBand(score) {
  if (score >= STRONG_AT) return 'strong';
  if (score >= FILE_AT) return 'moderate';
  return 'weak';
}

/** What the agent does with a finished analysis. */
export function routeByStrength(score, recommendedAction = 'file') {
  if (recommendedAction === 'accept') return { action: 'human_review', why: 'Agent recommends accepting; refunds are never issued without a person.' };
  if (score >= FILE_AT) return { action: 'auto_file', why: `Evidence score ${score} is at or above the ${FILE_AT} filing threshold.` };
  return { action: 'human_review', why: `Evidence score ${score} is below ${FILE_AT}: genuinely weak, so a person decides.` };
}

/**
 * @param {number} nowMs
 * @param {{state:string, due_at:string, opened_at?:string, nudged?:boolean}} rec
 * @returns {{action:'none'|'run_agent'|'file'|'file_best_effort'|'nudge_human'|'mark_missed', reason:string}}
 */
export function guardAction(nowMs, rec) {
  if (TERMINAL.has(rec.state)) return { action: 'none', reason: `state ${rec.state} is terminal` };
  const due = parseInstant(rec.due_at);
  if (nowMs >= due) return { action: 'mark_missed', reason: 'the response window has closed with nothing filed' };

  const hd = rec.hand_over_at ? { at_ms: parseInstant(rec.hand_over_at) } : humanDeadline(rec.opened_at ?? null, due);
  switch (rec.state) {
    case 'NEW':
      return { action: 'run_agent', reason: 'dispute has not been analysed yet' };
    case 'ANALYSED':
      return { action: 'file', reason: 'package is ready and routed for auto-filing' };
    case 'ESCALATED':
      if (nowMs >= hd.at_ms) {
        return { action: 'file_best_effort', reason: 'human did not act before the hand-over point; filing the best honest response beats a default' };
      }
      if (due - nowMs <= 24 * HOUR && !rec.nudged) return { action: 'nudge_human', reason: 'under 24 h left and still waiting on a person' };
      return { action: 'none', reason: 'waiting on a person; hand-over point not reached' };
    default:
      return { action: 'none', reason: `unknown state ${rec.state}` };
  }
}
