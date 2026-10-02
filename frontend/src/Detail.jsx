import React, { useState, useEffect, useRef } from 'react';
import { Ring, StateChip, Chip, Code, Provenance, DeadlineBadge, Confirm, Icon, useDialog, live, money, roughly, scoreTone, clockTime } from './util.jsx';

const Q = { strong: 'good', partial: 'amber', none: 'plain', contradicts: 'bad' };
const QW = { strong: 'Strong', partial: 'Partial', none: 'Missing', contradicts: 'Against the claim' };
const ORIGIN = { live: 'Live model run', seed_cache: 'Seeded result from an earlier model run', template_fallback: 'Template draft, no model call' };

function groupTrace(trace) {
  const groups = [];
  trace.forEach((t) => {
    const key = t.turn != null ? `Turn ${t.turn}` : t.step === 'agent' ? 'Agent' : 'Pipeline';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(t); else groups.push({ key, items: [t] });
  });
  return groups;
}

function Disc({ title, hint, children, open }) {
  return (
    <details className="disc" open={open}>
      <summary><b>{title}</b>{hint && <span>{hint}</span>}</summary>
      <div className="disc-body">{children}</div>
    </details>
  );
}

export default function Detail({ d, nowSim, onClose, run, busy, since }) {
  const a = d.analysis;
  const [notes, setNotes] = useState(a?.draft?.notes || '');
  const [dlg, setDlg] = useState(null);
  const ref = useRef(null);
  const onKey = useDialog(ref, onClose, '.modal-wrap');
  useEffect(() => { setNotes(a?.draft?.notes || ''); setDlg(null); }, [d.id, a?.at]);

  const L = live(d, nowSim);
  const dl = d.deadline || {};
  const canAct = ['ESCALATED', 'ANALYSED'].includes(d.state);
  const working = d.state === 'NEW';
  const refused = a?.route && /human|escalat/i.test(a.route.action || '');
  const tools = (d.trace || []).filter((t) => t.kind === 'tool' && t.step === 'agent');
  const toolGroups = groupTrace(tools);
  const req = d.filing?.request
    || (a?.evidence_payload && { method: 'POST', path: `/v1/customer/disputes/${d.id}/provide-evidence`, scope: 'disputes/update-seller', content_type: 'multipart/form-data', input: a.evidence_payload });

  async function confirm() {
    const ok = await run(d.id, dlg === 'file' ? 'file' : 'accept', dlg === 'file' ? { notes } : undefined);
    if (ok !== false) setDlg(null);
  }
  const secs = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : null;

  return (
    <div className="drawer-wrap" onKeyDown={onKey}>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="dr-t" ref={ref}>
        <header className="d-head">
          <div>
            <h2 id="dr-t">{d.item.name}</h2>
            <p className="muted">{d.reason_label} · {d.buyer.name} · {d.id}</p>
          </div>
          <button className="btn" onClick={onClose}><Icon n="x" size={16} /> Close</button>
        </header>

        <section className="d-top">
          <div className="dial-col"><Ring d={d} nowSim={nowSim} size="hero" /><DeadlineBadge d={d} nowSim={nowSim} /></div>
          <div className="d-side">
            <div className="amount">{money(d.amount)}</div>
            <p className="muted">{L.closed ? (d.filing ? `Filed by ${d.filing.by}${d.filing.margin_ms > 0 ? ` with ${roughly(d.filing.margin_ms)} to spare` : ''}.` : <StateChip state={d.state} />) : `Due ${dl.due_local || d.due_at}`}</p>
            {d.outcome && <p>{d.outcome.code}{d.outcome.simulated && ' (simulated)'}{d.outcome.default && ', by default'}. <span className="muted">{d.outcome.note}</span></p>}
            {working && <p className="banner" role="status"><Icon n="clock" /> The agent is working on this{secs != null ? `, ${secs} s so far` : ''}. This panel updates by itself.</p>}
            {d.filing_error && <p className="banner bad" role="alert">Filing failed: {String(d.filing_error)}. Review the response, then choose File response again.</p>}
            {d.missed_note && <p className="banner bad">{d.missed_note}</p>}
            {canAct && (
              <div className="actions">
                <button className="btn primary big" disabled={busy} onClick={() => setDlg('file')}>File response</button>
                <button className="btn danger-ghost" disabled={busy} onClick={() => setDlg('accept')}>Accept claim and refund buyer</button>
              </div>
            )}
            {d.state === 'FILED' && <div className="actions"><button className="btn" disabled={busy} onClick={() => run(d.id, 'adjudicate')}>Fast-forward PayPal's review (simulated)</button></div>}
            {!a && !working && <div className="actions"><button className="btn primary" disabled={busy} onClick={() => run(d.id, 'analyse')}>Run analysis</button></div>}
          </div>
        </section>

        <section className="d-sec">
          <h3>Response</h3>
          <blockquote><b>Buyer:</b> {d.buyer_claim}</blockquote>
          {a ? (d.state === 'ESCALATED'
            ? (<>
              <label className="sr" htmlFor="notes">Response text</label>
              <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={9} />
              <p className="muted">The evidence is weak, so the agent left the decision to you. You can edit this draft before filing.</p>
            </>)
            : <div className="draft">{a.draft.notes}</div>)
            : <p className="muted">{working ? 'The draft appears here when the agent finishes.' : 'No draft yet.'}</p>}
        </section>

        {a && (
          <Disc title="How it decided" hint={refused ? 'Escalated to you' : a.route?.action}>
            {refused && <p className="callout"><b>The agent chose not to file on its own.</b> When the evidence is weak, a person decides whether to defend or accept. That refusal is deliberate.</p>}
            <dl className="facts-dl">
              <dt>Classified as</dt><dd>{a.claim_theory}{a.consistent_with_filed_reason === false && ' (differs from the reason PayPal gave)'}</dd>
              <dt>Buyer's core complaint</dt><dd>{a.buyer_core_complaint}</dd>
              <dt>Strategy</dt><dd>{a.defence_strategy}</dd>
              <dt>Decision</dt><dd><b>{a.route?.action}</b>, {a.route?.decided_by === 'agent' ? 'decided by the agent' : 'decided by the routing rule'}</dd>
              <dt>Reason</dt><dd>{a.route?.why}</dd>
              {a.agent && (<><dt>Agent run</dt><dd>{a.agent.turns} of {a.agent.max_turns} model turns, {a.agent.tool_calls} tool calls</dd></>)}
              {a.origin && (<><dt>Source</dt><dd>{ORIGIN[a.origin] || a.origin}</dd></>)}
            </dl>

            <h4>Records pulled, in order</h4>
            {tools.length ? toolGroups.map((g, gi) => (
              <div className="tgroup" key={gi}>
                {g.key !== 'Agent' && <h5>{g.key}</h5>}
                <ol className="pulled">{g.items.map((t, i) => <li key={i}><code>{t.label || t.step}</code>{t.detail && <span>{t.detail}</span>}</li>)}</ol>
              </div>
            )) : <p className="muted">{a.agent?.fetched?.length ? a.agent.fetched.join(', ') : 'The routing rule pulled the standard set of records.'}</p>}

            <h4>Evidence score <Chip tone={scoreTone(a.band)} icon={a.band === 'strong' ? 'check' : 'warn'}>{a.score} of 100, {a.band}</Chip></h4>
            <ul className="checklist">
              {a.checklist.map((c, i) => (
                <li key={i} className={`ck q-${c.quality}`}>
                  <div className="ck-top"><span>{c.label}</span><span className="ck-w">{c.earned} of {c.weight}</span></div>
                  <div className="bar" aria-hidden="true"><i style={{ width: `${c.weight ? Math.min(100, Math.abs(c.earned / c.weight) * 100) : 0}%` }} /></div>
                  <small>{QW[c.quality] || c.quality}</small>
                </li>
              ))}
            </ul>

            <h4>Evidence found</h4>
            <ul className="items">
              {a.items.map((it) => (
                <li key={it.id}>
                  <div className="it-top"><b>{it.title}</b><Chip tone={Q[it.quality]} icon={it.quality === 'strong' ? 'check' : it.quality === 'contradicts' ? 'warn' : null}>{QW[it.quality] || it.quality}</Chip></div>
                  <p>{it.detail}</p>
                </li>
              ))}
            </ul>

            {a.draft?.weaknesses?.length > 0 && (
              <div className="callout bad"><b>Weaknesses the agent flagged</b><ul>{a.draft.weaknesses.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
            )}

            {d.trace?.length > 0 && (
              <details className="disc nested">
                <summary><b>Full trace</b><span>{d.trace.length} steps</span></summary>
                <div className="disc-body">
                  {groupTrace(d.trace).map((g, gi) => (
                    <div className="tgroup" key={gi}>
                      <h5>{g.key}</h5>
                      <ol className="trace">
                        {g.items.map((t, i) => (
                          <li key={i}>
                            <span className={`tag tag-${t.kind}`}>{t.kind}</span>
                            <div><b>{t.label || t.step}</b>{t.detail && <p>{t.detail}</p>}</div>
                            <time>{t.ms != null ? `${t.ms} ms` : ''}</time>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </Disc>
        )}

        {req && (
          <Disc title="PayPal request" hint={d.filing ? 'As filed' : 'As it would be sent'}>
            <p className="req-line"><b>{req.method}</b> <code>{req.path}</code></p>
            <p className="muted">Scope {req.scope} · {req.content_type}{d.filing && !d.filing.sent && '. Built and schema-validated, not sent.'}</p>
            {d.filing?.request_id && <p className="muted">PayPal-Request-Id: <code>{d.filing.request_id}</code>. Replaying this request cannot file twice.{d.filing.replays > 0 && ` Replayed ${d.filing.replays} ${d.filing.replays === 1 ? 'time' : 'times'}, filed once.`}</p>}
            <Code label="Multipart field: input">{req.input}</Code>
            {d.filing?.note && <p className="muted">{d.filing.note}</p>}
            <Provenance p={d.provenance} />
          </Disc>
        )}

        {d.history?.length > 0 && (
          <Disc title="History" hint={`${d.history.length} events`}>
            <ul className="hist">
              {d.history.map((h, i) => <li key={i}><time>{clockTime(h.t)}</time><b>{h.actor}</b> {h.event}{h.detail ? <em> {h.detail}</em> : null}</li>)}
            </ul>
            {d.retrospective && <p className="muted">{typeof d.retrospective === 'string' ? d.retrospective : JSON.stringify(d.retrospective)}</p>}
          </Disc>
        )}

        {dlg === 'file' && (
          <Confirm title={`File the response for ${d.id}?`} confirmLabel="File response" busy={busy} onCancel={() => setDlg(null)} onConfirm={confirm}>
            <p>The response above is sent as the evidence for this dispute. <b>Once filed, it cannot be edited or withdrawn.</b></p>
            <p className="muted">In this demo the request is built and validated against PayPal's spec but not sent.</p>
          </Confirm>
        )}
        {dlg === 'accept' && (
          <Confirm title={`Accept the claim on ${d.id}?`} tone="danger" confirmLabel="Accept claim and refund buyer" busy={busy} onCancel={() => setDlg(null)} onConfirm={confirm}>
            <p>This refunds <b>{money(d.amount)}</b> to the buyer and closes the dispute in their favour. You do not get the goods back. <b>This cannot be undone.</b></p>
            {a && <p className="muted">The evidence score is {a.score} of 100. Filing a defence is the other choice.</p>}
          </Confirm>
        )}
      </aside>
    </div>
  );
}
