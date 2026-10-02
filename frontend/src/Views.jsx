import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Code, Icon, money } from './util.jsx';

const FIG = [
  ['1,186,812', 'disputes initiated, 1 Jan to 30 Jun 2025', '39% more than the previous half-year'],
  ['1,349,343', 'disputes closed', '48% more than the previous half-year'],
  ['1,082,247', 'payment determinations rendered', 'About 55% up'],
  ['About 37%', 'of determinations came within 30 business days', '401,484 determinations. About 67% came within 60.'],
  ['40%', 'of initiated disputes had eligibility challenged', ''],
];

export function Evidence({ kpis }) {
  return (
    <div className="page">
      <h1 className="h1 left">The evidence</h1>
      <p className="lede big-lede"><b>22% of payment determinations were default decisions.</b> One party did not respond in time, so the other side won.</p>
      <p className="note">These figures describe US healthcare billing arbitration, <b>not PayPal commerce data</b>. The transferable finding is the mechanism: at scale, a fifth of outcomes are decided by a missed deadline rather than the merits.</p>
      <ul className="figs">
        {FIG.map(([n, t, s]) => (
          <li className="fig" key={n}><b className="n">{n}</b><span>{t}</span>{s && <small>{s}</small>}</li>
        ))}
      </ul>
      <p className="src">Source: Supplemental Background on Federal Independent Dispute Resolution Public Use Files, January 1, 2025 - June 30, 2025. HHS, Labor and Treasury.</p>
      <div className="lost">
        <Icon n="stop" size={22} />
      </div>
    </div>
  );
}

export function Compare({ disputes, selected, setSelected, openDetail }) {
  const [sur, setSur] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let off = false;
    setSur(null); setErr('');
    api.surrender(selected).then((r) => !off && setSur(r)).catch((e) => !off && setErr(e.message));
    return () => { off = true; };
  }, [selected]);
  const d = disputes.find((x) => x.id === selected);
  const a = d?.analysis;
  const usable = a ? a.items.filter((i) => i.quality === 'strong' || i.quality === 'partial').length : 0;
  return (
    <div className="page">
      <h1 className="h1 left">Surrender vs defend</h1>
      <section className="mcp" aria-labelledby="mcp-h">
        <h2 id="mcp-h" className="h2">What PayPal's MCP server exposes</h2>
        <table className="mcp-t">
          <caption className="sr">From a live run, recorded in docs/mcp-probe-output.txt</caption>
          <tbody>
            <tr><th scope="row">Tools listed by <code>npx @paypal/mcp --tools=all</code></th><td>28</td></tr>
            <tr><th scope="row">Dispute tools</th><td>3: <code>list_disputes</code>, <code>get_dispute</code>, <code>accept_dispute_claim</code></td></tr>
            <tr><th scope="row">Only write on disputes</th><td><code>accept_dispute_claim</code>, which closes the dispute for the buyer and refunds. No tool exists for evidence, appeal, escalate or offer.</td></tr>
            <tr><th scope="row">Remote server paths</th><td><code>/http</code> (the documented path) returns 404. <code>/mcp</code> returns 401, so it requires auth.</td></tr>
          </tbody>
        </table>
        <p className="src">Recorded output: <code>docs/mcp-probe-output.txt</code></p>
      </section>
      <div className="pick">
        <label htmlFor="cmp">Compare on</label>
        <select id="cmp" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {disputes.map((x) => <option key={x.id} value={x.id}>{x.item.name}, {money(x.amount)}</option>)}
        </select>
      </div>
      <div className="cmp">
        <section className="col surrender" aria-labelledby="c1">
          <div className="eyebrow">PayPal's MCP agent</div>
          <h2 id="c1"><code>accept_dispute_claim</code></h2>
          {err && <p className="banner bad" role="alert">{err} Pick another dispute or reload the page.</p>}
          {!sur && !err && <div aria-busy="true"><div className="skel" style={{ height: 26, width: '80%' }} /><div className="skel" style={{ height: 80, marginTop: 12 }} /></div>}
          {sur && (<>
            <ul className="facts">
              <li>Outcome: <b>buyer's favour</b>, full refund of <b>{money(sur.outcome?.amount_refunded)}</b></li>
              <li>Goods back: <b>{sur.outcome?.merchandise_returned ? 'Yes' : 'No'}</b></li>
              <li>Evidence available and ignored: <b>{sur.evidence_that_was_available?.score} of 100</b></li>
            </ul>
            <details className="disc nested">
              <summary><b>REST request</b><span>{sur.rest_equivalent?.method}</span></summary>
              <div className="disc-body"><p className="req-line"><code>{sur.rest_equivalent?.path}</code></p><Code>{sur.rest_equivalent?.body}</Code></div>
            </details>
            <p className="stamp"><Icon n="warn" size={15} /> Preview, nothing executed</p>
          </>)}
        </section>
        <section className="col defend" aria-labelledby="c2">
          <div className="eyebrow">Dispute Defence</div>
          <h2 id="c2">Defend with evidence</h2>
          {d && (<>
            <ul className="facts">
              <li>Evidence score: <b>{a ? `${a.score} of 100, ${a.band}` : 'not analysed yet'}</b></li>
              <li>Usable evidence items: <b>{usable} of {a ? a.items.length : 0}</b></li>
              <li>Outcome: <b>{d.outcome ? `${d.outcome.code} (simulated)` : d.filing ? 'Filed. Adjudication is simulated.' : 'Not filed yet'}</b></li>
            </ul>
            <button className="btn primary" onClick={() => openDetail(d.id)}>Open this dispute</button>
          </>)}
        </section>
      </div>
    </div>
  );
}
