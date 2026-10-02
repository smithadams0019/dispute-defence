import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateEvidences, buildProvideEvidenceRequest, toFormData } from '../src/paypal.js';
import ENUMS from '../src/generated/paypal-enums.json' with { type: 'json' };

const SNAP = JSON.parse(fs.readFileSync(new URL('../../spec/customer-disputes-v1.schema.json', import.meta.url), 'utf8'));

test('generated enums match the saved live-schema snapshot (not a stale copy)', () => {
  assert.equal(ENUMS.schema_version, SNAP.info.version);
  assert.deepEqual(ENUMS.evidence_type, SNAP.components.schemas.evidence_type.enum);
  assert.equal(ENUMS.operations.length, 15);
});

test('valid delivery evidence passes', () => {
  const p = { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ carrier_name: 'FEDEX', tracking_number: '774612308811' }] }, notes: 'Delivered.' }] };
  assert.deepEqual(validateEvidences(p), []);
  const req = buildProvideEvidenceRequest('PP-D-1', p);
  assert.equal(req.path, '/v1/customer/disputes/PP-D-1/provide-evidence');
  assert.equal(req.content_type, 'multipart/form-data');
  const fd = toFormData(req);
  assert.ok(fd.has('input'));
});

test('bad evidence_type, bad carrier, missing tracking number, oversize notes are all caught', () => {
  const bad = { evidences: [
    { evidence_type: 'NOT_A_TYPE', notes: 'x' },
    { evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ carrier_name: 'PIGEON', tracking_number: '' }] }, notes: 'x'.repeat(2001) },
    { evidence_type: 'PROOF_OF_REFUND' },
  ] };
  const problems = validateEvidences(bad);
  assert.ok(problems.some((m) => /NOT_A_TYPE/.test(m)));
  assert.ok(problems.some((m) => /PIGEON/.test(m)));
  assert.ok(problems.some((m) => /tracking_number is required/.test(m)));
  assert.ok(problems.some((m) => /2001 chars/.test(m)));
  assert.ok(problems.some((m) => /evidence_info is expected for PROOF_OF_REFUND/.test(m)));
  assert.throws(() => buildProvideEvidenceRequest('PP-D-1', bad), /failed schema validation/);
});

test('empty payload rejected', () => {
  assert.ok(validateEvidences({}).length);
  assert.ok(validateEvidences({ evidences: [] }).length);
});
