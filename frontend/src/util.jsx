import React, { useEffect, useRef } from 'react';

export const CLOSED = ['FILED', 'ACCEPTED', 'RESOLVED', 'MISSED'];
export const isOpen = (d) => !CLOSED.includes(d.state);
export const pad = (n) => String(n).padStart(2, '0');
const H = 3600000;

export function parts(ms) {
  const s = Math.floor(Math.abs(ms) / 1000);
  return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}
export function short(ms) {
  const p = parts(ms);
  if (p.days) return `${p.days}d ${pad(p.hours)}h ${pad(p.minutes)}m ${pad(p.seconds)}s`;
  if (p.hours) return `${p.hours}h ${pad(p.minutes)}m ${pad(p.seconds)}s`;
  return `${p.minutes}m ${pad(p.seconds)}s`;
}
export function roughly(ms) {
  const p = parts(ms);
  if (p.days) return `${p.days}d ${p.hours}h`;
  if (p.hours) return `${p.hours}h ${p.minutes}m`;
  return `${p.minutes}m`;
}
export function money(a, cur) {
  if (a == null || a === '') return '';
  let v = a, c = cur || 'USD';
  if (typeof a === 'object') { v = a.value; c = a.currency_code || c; }
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n); }
  catch { return `${n.toFixed(2)} ${c}`; }
}
export function clockTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; }
}

export const STATE_LABEL = {
  NEW: 'Agent working', ANALYSED: 'Response drafted', ESCALATED: 'Needs you', FILED: 'Filed', ACCEPTED: 'Accepted', RESOLVED: 'Resolved', MISSED: 'Missed',
};

/** Live deadline state computed from due_at and the sim clock. */
export function live(d, nowSim) {
  const rem = Date.parse(d.due_at) - nowSim;
  const dl = d.deadline || {};
  const closed = !isOpen(d);
  let band;
  if (closed) band = d.state === 'MISSED' ? 'expired' : 'closed';
  else if (rem <= 0) band = 'expired';
  else if (rem < 6 * H) band = 'critical';
  else if (rem < 24 * H) band = 'urgent';
  else if (rem < 72 * H) band = 'soon';
  else band = 'ok';
  const frac = dl.window_ms ? Math.max(0, Math.min(1, rem / dl.window_ms)) : 0.5;
  return { rem, band, closed, frac, expired: band === 'expired' };
}

export function bandWords(L, d) {
  switch (L.band) {
    case 'expired': return `Overdue by ${roughly(L.rem)}`;
    case 'critical': return 'Under 6 hours left';
    case 'urgent': return 'Under 24 hours left';
    case 'soon': return 'Under 3 days left';
    case 'ok': return 'More than 3 days left';
    default: return d ? STATE_LABEL[d.state] : 'Closed';
  }
}

const PATHS = {
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6z', clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  shield: 'M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z', reset: 'M4 12a8 8 0 1 0 3-6M4 4v5h5',
  scale: 'M12 4v16M6 8h12M6 8l-3 7h6zM18 8l-3 7h6z', home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
  list: 'M5 7h14M5 12h14M5 17h14', chart: 'M5 20V10M12 20V4M19 20v-7', plus: 'M12 5v14M5 12h14',
  warn: 'M12 3 2 20h20zM12 10v5M12 17.5v.5', stop: 'M8 3h8l5 5v8l-5 5H8l-5-5V8zM9 9l6 6M15 9l-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5', sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z', menu: 'M4 7h16M4 12h16M4 17h16', x: 'M6 6l12 12M18 6 6 18',
  refresh: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5',
};
export const Icon = ({ n, size = 18 }) => (
  <svg className="ico" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d={PATHS[n]} /></svg>
);
const BAND_ICON = { ok: 'clock', soon: 'clock', urgent: 'warn', critical: 'warn', expired: 'stop', closed: 'check' };

export function DeadlineBadge({ d, nowSim }) {
  const L = live(d, nowSim);
  return <span className={`dbadge band-${L.band}`}><Icon n={BAND_ICON[L.band]} size={15} />{bandWords(L, d)}</span>;
}

export function StateChip({ state }) {
  const icon = state === 'ESCALATED' ? 'warn' : state === 'MISSED' ? 'stop' : ['FILED', 'RESOLVED', 'ACCEPTED'].includes(state) ? 'check' : null;
  return <span className={`chip st-${state}`}>{icon && <Icon n={icon} size={13} />}{STATE_LABEL[state] || state}</span>;
}
export function Chip({ tone = 'plain', icon, children }) {
  return <span className={`chip tone-${tone}`}>{icon && <Icon n={icon} size={13} />}{children}</span>;
}

/** The dial: the signature element. */
export function Ring({ d, nowSim, size = 'hero' }) {
  const L = live(d, nowSim);
  const R = 88, C = 2 * Math.PI * R;
  const p = parts(L.rem);
  const fill = L.closed || L.expired ? 1 : Math.max(0.02, Math.min(1, L.rem / (72 * H)));
  let center;
  if (L.closed && !L.expired) {
    const m = d.filing && d.filing.margin_ms;
    center = (<>
      <div className="ring-kicker">{STATE_LABEL[d.state]}</div>
      <div className="ring-digits ring-done">Done</div>
      <div className="ring-sub">{m != null && m > 0 ? `${roughly(m)} to spare` : 'before the deadline'}</div>
    </>);
  } else if (L.expired) {
    center = (<>
      <div className="ring-kicker">Overdue</div>
      <div className="ring-digits">{pad(p.days * 24 + p.hours)}:{pad(p.minutes)}:{pad(p.seconds)}</div>
      <div className="ring-sub">hours : min : sec past</div>
    </>);
  } else {
    center = (<>
      <div className="ring-kicker">Time left</div>
      {p.days > 0 && <div className="ring-days">{p.days} {p.days === 1 ? 'day' : 'days'}</div>}
      <div className="ring-digits">{pad(p.hours)}:{pad(p.minutes)}:{pad(p.seconds)}</div>
      <div className="ring-sub">hours : min : sec</div>
    </>);
  }
  return (
    <div className={`ring ring-${size} band-${L.band}`} role="timer" aria-label={L.closed ? bandWords(L, d) : `${short(L.rem)} ${L.expired ? 'overdue' : 'left'}`}>
      <svg viewBox="0 0 220 220" aria-hidden="true">
        <circle className="ring-plate" cx="110" cy="110" r="108" />
        <circle className="ring-ticks" cx="110" cy="110" r="102" />
        <circle className="ring-track" cx="110" cy="110" r={R} />
        <circle className="ring-arc" cx="110" cy="110" r={R} strokeDasharray={`${C * fill} ${C}`} transform="rotate(-90 110 110)" />
      </svg>
      <div className="ring-center">{center}</div>
    </div>
  );
}

/** Compact countdown with its words. */
export function Mini({ d, nowSim, words = true }) {
  const L = live(d, nowSim);
  let t;
  if (L.closed && !L.expired) {
    const m = d.filing && d.filing.margin_ms;
    t = m != null && m > 0 ? `${roughly(m)} to spare` : STATE_LABEL[d.state];
  } else if (L.expired) t = `+${short(L.rem)}`;
  else t = short(L.rem);
  return (
    <span className={`mini-wrap band-${L.band}`}>
      <span className="mini">{t}</span>
      {words && <DeadlineBadge d={d} nowSim={nowSim} />}
    </span>
  );
}

export function Code({ children, label }) {
  return (
    <div className="code">
      {label && <div className="code-label">{label}</div>}
      <pre tabIndex={0}>{typeof children === 'string' ? children : JSON.stringify(children, null, 2)}</pre>
    </div>
  );
}

export function Provenance({ p }) {
  if (!p) return null;
  const entries = Object.entries(p).filter(([, v]) => v);
  if (!entries.length) return null;
  return (
    <dl className="prov">
      {entries.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}
    </dl>
  );
}

export const scoreTone = (b) => (b === 'strong' ? 'good' : b === 'moderate' ? 'amber' : 'bad');

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input:not([disabled]),select,[tabindex]:not([tabindex="-1"])';
/** Focus trap with Escape to close, restoring focus on unmount. Works even when focus has been lost. */
export function useDialog(ref, onClose, yieldTo) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    if (el) {
      const first = el.querySelector('[data-autofocus]') || el.querySelector('button,textarea,input,select,a[href]') || el;
      first.focus({ preventScroll: true });
    }
    const onKeyDoc = (e) => {
      if (e.key !== 'Escape') return;
      if (yieldTo && document.querySelector(yieldTo)) return;
      closeRef.current();
    };
    const onFocusIn = (e) => {
      if (yieldTo && document.querySelector(yieldTo)) return;
      if (ref.current && !ref.current.contains(e.target)) {
        const f = ref.current.querySelector('[data-autofocus]') || ref.current.querySelector(FOCUSABLE) || ref.current;
        f.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDoc);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDoc);
      document.removeEventListener('focusin', onFocusIn);
      if (prev && prev.focus) prev.focus({ preventScroll: true });
    };
  }, [ref, yieldTo]);
  return (e) => {
    if (e.key !== 'Tab') return;
    const nodes = [...ref.current.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    e.stopPropagation();
  };
}

export function Confirm({ title, children, confirmLabel, tone = 'primary', busy, onConfirm, onCancel }) {
  const ref = useRef(null);
  const onKey = useDialog(ref, onCancel);
  return (
    <div className="modal-wrap" onKeyDown={onKey}>
      <div className="scrim" onClick={onCancel} />
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="cf-t" aria-describedby="cf-b" ref={ref}>
        <h2 id="cf-t">{title}</h2>
        <div id="cf-b" className="modal-body">{children}</div>
        <div className="modal-actions">
          <button className="btn" data-autofocus onClick={onCancel}>Cancel</button>
          <button className={`btn ${tone}`} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
