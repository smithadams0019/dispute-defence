import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import { Ring, Mini, StateChip, Chip, DeadlineBadge, Icon, live, isOpen, money, scoreTone, roughly, STATE_LABEL } from './util.jsx';
import Detail from './Detail.jsx';
import { Evidence, Compare } from './Views.jsx';

const TEMPLATES = [
  { id: 'inr-signed', title: 'Item not received', sub: 'A signed delivery is on file' },
  { id: 'unauthorised', title: 'Unauthorised charge', sub: 'The buyer says they never bought it' },
];
const VIEWS = ['home', 'disputes', 'evidence', 'compare'];

function parseHash() {
  const h = (window.location.hash || '').replace(/^#\/?/, '');
  const [v, q] = h.split('?');
  const view = VIEWS.includes(v) ? v : 'home';
  const d = q && /^d=/.test(q) ? decodeURIComponent(q.slice(2)) : null;
  return { view, d };
}
function setHash(view, d) {
  const h = `#/${view}${d ? `?d=${encodeURIComponent(d)}` : ''}`;
  if (window.location.hash !== h) window.history.pushState(null, '', h);
}

function greeting(tz) {
  let h = new Date().getHours();
  try { h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date())) % 24; } catch { /* local */ }
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function resultLine(d) {
  if (d.filing) {
    const m = d.filing.margin_ms;
    return `${d.id}: filed${m > 0 ? ` ${Math.round(m / 60000).toLocaleString()} minutes before the deadline` : ''}${d.filing.by === 'guard' ? ' by the guard' : ''}.`;
  }
  if (d.state === 'ESCALATED') return `${d.id}: handed to you. The agent judged the evidence too weak to file.`;
  return `${d.id}: ${STATE_LABEL[d.state] || d.state}.`;
}

export default function App() {
  const [st, setSt] = useState(null);
  const [skew, setSkew] = useState(0);
  const [, setTick] = useState(0);
  const [loadErr, setLoadErr] = useState('');
  const [pp, setPp] = useState(null);
  const [route, setRoute] = useState(parseHash);
  const [cmpId, setCmpId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [guardOn, setGuardOn] = useState(true);
  const [tpl, setTpl] = useState('inr-signed');
  const [flow, setFlow] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');
  const seen = useRef(new Map()); // NEW disputes -> first seen ms
  const flowRef = useRef(null); flowRef.current = flow;

  const toast = useCallback((text, tone = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 11000);
  }, []);

  const settle = useCallback((s) => {
    const nowNew = new Set();
    s.disputes.forEach((d) => {
      if (d.state === 'NEW') { nowNew.add(d.id); if (!seen.current.has(d.id)) seen.current.set(d.id, Date.now()); }
    });
    [...seen.current.keys()].forEach((id) => {
      if (nowNew.has(id)) return;
      seen.current.delete(id);
      const d = s.disputes.find((x) => x.id === id);
      if (!d) return;
      toast(resultLine(d), d.state === 'ESCALATED' ? 'guard' : 'ok');
      if (flowRef.current && flowRef.current.id === id) setFlow({ ...flowRef.current, phase: 'done' });
    });
  }, [toast]);

  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      setSkew(Date.parse(s.sim_now) - Date.now());
      setSt(s); setLoadErr(''); settle(s);
      return s;
    } catch (e) { setLoadErr(e.message); return null; }
  }, [settle]);

  const announce = useCallback((acted, s) => {
    (acted || []).forEach((a) => {
      const d = s?.disputes?.find((x) => x.id === a.id);
      const m = d?.filing?.margin_ms;
      const verb = a.action === 'file' || a.action === 'filed' ? 'filed' : String(a.action).replace(/_/g, ' ');
      toast(`Guard ${verb} ${a.id}${m > 0 ? ` with ${roughly(m)} to spare` : ''}.${a.reason ? ` ${a.reason}` : ''}`, 'guard');
    });
  }, [toast]);

  const loadPaypal = useCallback(() => api.paypalStatus().then(setPp).catch(() => setPp({ error: true })), []);

  useEffect(() => { refresh(); loadPaypal(); }, [refresh, loadPaypal]);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const t = setInterval(async () => {
      try { const r = await api.sweep(); const s = await refresh(); if (r.acted?.length) announce(r.acted, s); } catch { /* next tick retries */ }
    }, 20000);
    return () => clearInterval(t);
  }, [refresh, announce]);
  const anyNew = !!st?.disputes?.some((d) => d.state === 'NEW');
  useEffect(() => {
    if (!anyNew) return undefined;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [anyNew, refresh]);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('popstate', on); window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, []);

  const nowSim = Date.now() + skew;
  const disputes = st?.disputes || [];
  const k = st?.kpis || {};
  const view = route.view;
  const detailId = route.d;
  const go = (v) => { setHash(v, null); setRoute({ view: v, d: null }); setNavOpen(false); window.scrollTo(0, 0); };
  const openDetail = (id) => { setHash(view, id); setRoute({ view, d: id }); };
  const closeDetail = () => { setHash(view, null); setRoute({ view, d: null }); };

  const sorted = useMemo(() => [...disputes].sort((a, b) => {
    const ao = isOpen(a), bo = isOpen(b);
    if (ao !== bo) return ao ? -1 : 1;
    return Date.parse(a.due_at) - Date.parse(b.due_at);
  }), [disputes]);
  const urgent = disputes.find((d) => d.id === k.most_urgent_id && isOpen(d)) || sorted.find(isOpen);
    const detail = disputes.find((d) => d.id === detailId);

  const failToast = (e, what) => {
    if (e instanceof ApiError && e.status === 409) {
      toast('This dispute changed while you were looking. The board has been refreshed.', 'guard');
      refresh();
      return 'stale';
    }
    toast(`${what} failed: ${e.message} Choose Refresh the board, then try again.`, 'bad');
    return false;
  };

  async function run(id, verb, body) {
    setBusy(true);
    try {
      const r = await api.act(id, verb, body);
      const s = await refresh();
      if (verb === 'file') toast(r?.idempotent_replay ? `${id}: already filed. Replaying the request cannot file twice.` : `${id}: filed.${s?.disputes?.find((x) => x.id === id)?.filing?.margin_ms > 0 ? ` ${roughly(s.disputes.find((x) => x.id === id).filing.margin_ms)} to spare.` : ''}`);
      else if (verb === 'accept') toast(`${id}: accepted. The buyer is refunded.`);
      else if (verb === 'adjudicate') toast(`${id}: PayPal's review fast-forwarded (simulated).`);
      else if (verb === 'analyse') toast(r?.queued ? `${id}: the agent is working on it.` : `${id}: analysis finished.`);
      setBusy(false);
      return true;
    } catch (e) { setBusy(false); return failToast(e, `${id} ${verb}`) === 'stale'; }
  }

  async function deliver() {
    if (flow && (flow.phase === 'sending' || flow.phase === 'working')) return;
    const before = new Set(disputes.map((d) => d.id));
    setFlow({ phase: 'sending', t0: Date.now() });
    try {
      const r = await api.webhook(tpl);
      const s = await refresh();
      const fresh = r?.dispute_id || r?.id || s?.disputes?.find((d) => !before.has(d.id))?.id;
      const d = s?.disputes?.find((x) => x.id === fresh);
      setFlow({ phase: d && d.state !== 'NEW' ? 'done' : 'working', id: fresh, t0: Date.now() });
      if (d && d.state !== 'NEW') toast(resultLine(d), d.state === 'ESCALATED' ? 'guard' : 'ok');
    } catch (e) {
      setFlow({ phase: 'failed', error: e.message, t0: Date.now() });
    }
  }
  async function advance(ms) {
    setBusy(true);
    try {
      const r = await api.clock(guardOn ? { advance_ms: ms } : { advance_ms: ms, guard: 'off' });
      const s = await refresh();
      if (r.acted?.length) announce(r.acted, s);
      else toast(`Demo clock moved forward ${roughly(ms)}${guardOn ? '' : ' with the guard off'}.`);
    } catch (e) { toast(`Could not move the clock: ${e.message} Choose Refresh the board, then try again.`, 'bad'); }
    setBusy(false);
  }
  async function sweep() {
    setBusy(true);
    try {
      const r = await api.sweep(); const s = await refresh();
      if (r.acted?.length) announce(r.acted, s); else toast('Guard ran. No dispute needed action.');
    } catch (e) { toast(`Guard could not run: ${e.message} Choose Refresh the board, then try again.`, 'bad'); }
    setBusy(false);
  }
  async function reset() {
    setBusy(true);
    try { await api.clock({ reset: true }); await api.reset(); await refresh(); setFlow(null); closeDetail(); toast('Board reset.'); }
    catch (e) { toast(`Could not reset: ${e.message} Choose Refresh the board, then try again.`, 'bad'); }
    setBusy(false);
  }
  async function refreshBoard() {
    const s = await refresh();
    if (s) { toast('Board refreshed.'); if (flow?.phase === 'failed') setFlow(null); loadPaypal(); }
  }
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); document.documentElement.dataset.theme = next;
    try { localStorage.setItem('dd-theme', next); } catch { /* not persisted */ }
  }

  const offsetH = st ? st.clock_offset_ms / 3600000 : 0;
  const [realOpen, setRealOpen] = useState(false);
  const open = sorted.filter(isOpen);
  const closed = sorted.filter((d) => !isOpen(d));
  const flowBusy = flow && (flow.phase === 'sending' || flow.phase === 'working');
  const navBtn = (v, icon, label, count) => (
    <button className={view === v ? 'on' : ''} aria-current={view === v ? 'page' : undefined} onClick={() => go(v)}>
      <Icon n={icon} />{label}{count !== undefined && count !== '' && <em>{count}</em>}
    </button>
  );

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <aside className={`side ${navOpen ? 'open' : ''}`} id="sidebar">
        <div className="brand"><span className="mark"><Icon n="shield" size={20} /></span><div><b>Dispute Defence</b><small>{st?.merchant?.name || 'Seller console'}</small></div></div>
        <nav aria-label="Main">
          {navBtn('home', 'home', 'Home', st ? k.open : '')}
          {navBtn('disputes', 'list', 'All disputes', st ? disputes.length : '')}
          {navBtn('evidence', 'chart', 'The evidence')}
          {navBtn('compare', 'scale', 'Surrender vs defend')}
        </nav>
      </aside>
      {navOpen && <div className="scrim side-scrim" onClick={() => setNavOpen(false)} />}

      <main className="main" id="main">
        <div className="honest">
          <button className="link-btn" aria-expanded={realOpen} aria-controls="real" onClick={() => setRealOpen(!realOpen)}>What is real?</button>
          {realOpen && (
            <div className="real" id="real">
              <table>
                <tbody>
                  <tr><th scope="row">Disputes</th><td>Fixtures, not PayPal objects.</td></tr>
                  <tr><th scope="row">PayPal connection</th><td>{pp && !pp.error ? `Live ${pp.mode}: oauth ${pp.oauth}, ${(pp.dispute_scopes || []).length} dispute scopes` : 'Sandbox status unavailable.'}</td></tr>
                  <tr><th scope="row">Filings</th><td>Built and schema-validated against PayPal's live spec{pp?.schema?.version ? ` (version ${pp.schema.version})` : ''}, not sent.</td></tr>
                  <tr><th scope="row">Adjudication</th><td>Simulated.</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="topbar">
          <button className="btn burger" onClick={() => setNavOpen(!navOpen)} aria-expanded={navOpen} aria-controls="sidebar"><Icon n="menu" /> Menu</button>
          <div className="chips">
            {st && st.clock_offset_ms > 0 && <Chip tone="amber" icon="clock">Demo clock +{Math.round(offsetH * 10) / 10}h (simulated)</Chip>}
            <button className="btn sm" onClick={toggleTheme}><Icon n={theme === 'dark' ? 'sun' : 'moon'} size={16} /> {theme === 'dark' ? 'Light theme' : 'Dark theme'}</button>
          </div>
        </div>

        {loadErr && (
          <div className="banner bad wide-banner" role="alert">
            <span><b>Could not load the board.</b> {loadErr} Check your connection, then choose Refresh the board.</span>
            <button className="btn sm" onClick={refreshBoard}><Icon n="refresh" size={15} /> Refresh the board</button>
          </div>
        )}

        {!st && !loadErr && <Skeleton />}

        {st && view === 'home' && (
          <div className="page home-page">
            <h1 className="h1">{greeting(st.tz)}. {k.open ? `${k.open} ${k.open === 1 ? 'dispute is' : 'disputes are'}` : 'No disputes are'} on the clock.</h1>

            {urgent
              ? <Attention d={urgent} nowSim={nowSim} tz={st.tz} open={() => openDetail(urgent.id)} />
              : <p className="quiet">Nothing needs you. The agent works new disputes as they arrive.</p>}

            <section className="demo" aria-label="Demo controls">
              <span className="demo-l">Demo controls</span>
              <div className="demo-g" role="radiogroup" aria-label="Dispute template">
                {TEMPLATES.map((t) => (
                  <label key={t.id} className={tpl === t.id ? 'seg on' : 'seg'}>
                    <input type="radio" name="tpl" checked={tpl === t.id} onChange={() => setTpl(t.id)} />{t.title}
                  </label>
                ))}
                <button className="btn sm primary" onClick={deliver} disabled={flowBusy}>Deliver webhook</button>
              </div>
              <div className="demo-g" role="group" aria-label="Advance the demo clock">
                {[1, 6, 24].map((h) => <button key={h} className="btn sm" aria-label={`Advance ${h} ${h === 1 ? 'hour' : 'hours'}`} disabled={busy} onClick={() => advance(h * 3600000)}>+{h}h</button>)}
                <label className="toggle"><input type="checkbox" checked={guardOn} onChange={(e) => setGuardOn(e.target.checked)} /><span aria-hidden="true" /> Guard {guardOn ? 'on' : 'off'}</label>
              </div>
              <div className="demo-g">
                <button className="btn sm" onClick={sweep} disabled={busy}>Run guard now</button>
                <button className="btn sm" onClick={reset} disabled={busy}>Reset demo</button>
              </div>
            </section>
            {flow && <FlowCard flow={flow} disputes={disputes} open={openDetail} dismiss={() => setFlow(null)} refresh={refreshBoard} />}

            {open.length > 0 && <DisputeTable rows={open} nowSim={nowSim} openDetail={openDetail} />}
            {closed.length > 0 && (
              <details className="closed">
                <summary>Closed ({closed.length})</summary>
                <DisputeTable rows={closed} nowSim={nowSim} openDetail={openDetail} />
              </details>
            )}
          </div>
        )}

        {st && view === 'disputes' && (
          <div className="page"><h1 className="h1 left">All disputes</h1>
            {open.length > 0 && <DisputeTable rows={open} nowSim={nowSim} openDetail={openDetail} />}
            {closed.length > 0 && (
              <details className="closed" open={open.length === 0}>
                <summary>Closed ({closed.length})</summary>
                <DisputeTable rows={closed} nowSim={nowSim} openDetail={openDetail} />
              </details>
            )}
            {!sorted.length && <p className="quiet">No disputes yet. When PayPal sends one, the agent works it and it appears here.</p>}
          </div>
        )}
        {st && view === 'evidence' && <Evidence kpis={k} />}
        {st && view === 'compare' && (disputes.length
          ? <Compare disputes={disputes} selected={disputes.some((x) => x.id === cmpId) ? cmpId : (disputes.find((x) => x.state === 'FILED') || disputes[0]).id} setSelected={setCmpId} openDetail={openDetail} />
          : <div className="page"><p className="quiet">Nothing to compare yet. Deliver a webhook from Home, then return here.</p></div>)}
      </main>

      {detailId && st && (detail
        ? <Detail d={detail} nowSim={nowSim} onClose={closeDetail} run={run} busy={busy} since={seen.current.get(detail.id)} />
        : <MissingDetail id={detailId} onClose={closeDetail} />)}
      <div className="toasts" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <Icon n={t.tone === 'bad' ? 'stop' : t.tone === 'guard' ? 'shield' : 'check'} />
            <span>{t.text}</span>
            <button className="icon-btn" aria-label="Dismiss message" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><Icon n="x" size={16} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MissingDetail({ id, onClose }) {
  return (
    <div className="drawer-wrap"><div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Dispute not found">
        <h2>{id} is not on this board</h2>
        <p className="muted">It may have been removed by a reset. Close this panel to return to the board.</p>
        <button className="btn primary" onClick={onClose}>Close</button>
      </aside>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading the board">
      <div className="skel" style={{ height: 40, width: '60%', margin: '14px auto 18px' }} />
      <div className="skel" style={{ height: 120, maxWidth: 760, margin: '0 auto' }} />
      <div className="skel" style={{ height: 340, marginTop: 40 }} />
      <div className="skel" style={{ height: 160, marginTop: 24 }} />
    </div>
  );
}



function FlowCard({ flow, disputes, open, dismiss, refresh }) {
  const d = flow.id ? disputes.find((x) => x.id === flow.id) : null;
  const secs = Math.max(0, Math.floor((Date.now() - flow.t0) / 1000));
  if (flow.phase === 'failed') {
    return (
      <div className="flow banner bad" role="alert">
        <div><b>The webhook request did not finish.</b> {flow.error} The dispute may still have been created. Choose Refresh the board to check.</div>
        <button className="btn sm" onClick={refresh}><Icon n="refresh" size={15} /> Refresh the board</button>
      </div>
    );
  }
  const working = flow.phase === 'sending' || flow.phase === 'working';
  return (
    <div className="flow" aria-live="polite">
      <div className="flow-head">
        <b>{flow.phase === 'sending' ? 'Sending the webhook' : working ? `The agent is working on ${flow.id || 'the new dispute'}` : `${flow.id} is processed`}</b>
        {working && <span className="elapsed">{secs} s elapsed</span>}
      </div>
      {working && <div className="indet" role="progressbar" aria-label="Agent working" aria-busy="true"><i /></div>}
      {working && <p className="muted">A live model run takes 30 to 90 seconds. This page updates by itself.</p>}
      {working && d?.trace?.length > 0 && (
        <ul className="mini-trace">{d.trace.slice(-8).map((t, i) => <li key={i}><span className={`tag tag-${t.kind}`}>{t.kind}</span> {t.label || t.step}</li>)}</ul>
      )}
      {!working && d && (
        <div className="flow-res">
          <span>{d.filing ? 'Filed.' : d.state === 'ESCALATED' ? 'Handed to you.' : STATE_LABEL[d.state]} Evidence {d.analysis?.score ?? 'pending'}{d.analysis ? ' of 100' : ''}.</span>
          <button className="btn sm primary" onClick={() => open(d.id)}>Open dispute</button>
          <button className="btn sm" onClick={dismiss}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

function Attention({ d, nowSim, tz, open }) {
  const L = live(d, nowSim);
  const dl = d.deadline || {};
  const a = d.analysis;
  const handIn = dl.hand_over_applies ? dl.hand_over_remaining_ms - ((dl.remaining_ms ?? 0) - L.rem) : null;
  const tint = L.band === 'expired' ? 'expired' : (L.band === 'urgent' || L.band === 'critical') ? 'urgent' : 'calm';
  const working = d.state === 'NEW';
  const count = (q) => (a ? a.items.filter((i) => i.quality === q).length : 0);
  const handTime = (dl.hand_over_local || '').match(/\d{1,2}:\d{2}.*$/)?.[0];
  const dueTime = (dl.due_local || '').match(/\d{1,2}:\d{2}.*$/)?.[0];
  let guardLine;
  if (L.expired) guardLine = 'The deadline has passed. Open the dispute to see what the guard did.';
  else if (dl.hand_over_applies && handIn > 0 && handTime) guardLine = `If nobody acts, the agent files the best response at ${handTime}.`;
  else if (dl.hand_over_applies) guardLine = 'The agent is filing the best response now.';
  else guardLine = `The deadline is ${dueTime || dl.due_local}.`;
  return (
    <section className={`attn tint-${tint}`} aria-label="Needs your attention">
      <div className="attn-l">
        <div className="eyebrow">Waiting on you since {new Date(a?.at || d.opened_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz, timeZoneName: 'short' })}</div>
        <h2>{d.reason_label}: {money(d.amount)} on {d.item.name}. {working ? 'The agent is working on it.' : d.state === 'ESCALATED' ? 'The evidence is weak, so you decide.' : 'The agent has a response ready.'}</h2>
        {a && <p className="attn-sum">Evidence {a.score} of 100: {count('strong')} strong, {count('partial')} partial, {count('contradicts')} against the claim.</p>}
        <p className="attn-line">{guardLine}</p>
        <button className="btn primary big" onClick={open}>Review and file</button>
      </div>
      <div className="dial-col"><Ring d={d} nowSim={nowSim} size="hero" /><DeadlineBadge d={d} nowSim={nowSim} /></div>
    </section>
  );
}

function DisputeTable({ rows, nowSim, openDetail }) {
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th scope="col">Dispute</th><th scope="col">Time left</th><th scope="col">Evidence</th><th scope="col" className="r">Amount</th><th scope="col">State</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td data-label="Dispute"><button className="rowlink" onClick={() => openDetail(d.id)} aria-label={`Open ${d.item.name}, ${d.buyer.name}${d.source === 'PAYPAL' ? ', a real PayPal dispute' : ''}`}><b>{d.item.name}</b><small>{d.buyer.name}</small></button></td>
              <td data-label="Time left" className="dl" title={d.deadline?.due_local ? `Due ${d.deadline.due_local}` : undefined}><Mini d={d} nowSim={nowSim} /></td>
              <td data-label="Evidence">{d.analysis ? <Chip tone={scoreTone(d.analysis.band)}>{d.analysis.band === 'strong' ? 'Strong' : d.analysis.band === 'moderate' ? 'Moderate' : 'Weak'} {d.analysis.score}</Chip> : <span className="muted">Pending</span>}</td>
              <td data-label="Amount" className="r">{money(d.amount)}</td>
              <td data-label="State"><StateChip state={d.state} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
