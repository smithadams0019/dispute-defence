// Regenerates src/generated/paypal-enums.json from the LIVE schema (or the saved snapshot with --offline).
import fs from 'node:fs';
const URL_ = 'https://developer.paypal.com/api/customer-disputes/v1/schema.json';
const snap = new URL('../../spec/customer-disputes-v1.schema.json', import.meta.url);
let schema;
if (process.argv.includes('--offline')) schema = JSON.parse(fs.readFileSync(snap, 'utf8'));
else {
  const r = await fetch(URL_);
  if (!r.ok) throw new Error(`schema fetch ${r.status}`);
  const text = await r.text();
  fs.writeFileSync(snap, text);
  schema = JSON.parse(text);
}
const c = schema.components.schemas;
const out = {
  schema_version: schema.info.version,
  fetched_from: URL_,
  evidence_type: c.evidence_type.enum,
  carrier_name: c.tracking_info.properties.carrier_name.enum,
  dispute_reason: c.dispute_reason.enum,
  dispute_state: c.dispute_state.enum,
  life_cycle_stage: c.dispute_lifecycle_stage.enum,
  outcome_code: c.dispute_outcome_code.enum,
  accept_claim_type: c.accept_claim_type.enum,
  evidence_notes_max: c.evidence.properties.notes.maxLength,
  operations: Object.entries(schema.paths).flatMap(([p, v]) => Object.entries(v).filter(([, o]) => o && o.operationId).map(([m, o]) => ({
    method: m.toUpperCase(), path: p, id: o.operationId, scopes: [...new Set((o.security || []).flatMap((s) => Object.values(s).flat()))].map((s) => s.split('/').pop()),
  }))),
};
fs.mkdirSync(new URL('../src/generated/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../src/generated/paypal-enums.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('schema', out.schema_version, 'ops', out.operations.length, 'evidence_types', out.evidence_type.length, 'carriers', out.carrier_name.length);
