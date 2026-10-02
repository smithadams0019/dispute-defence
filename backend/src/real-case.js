// The one real dispute in this sandbox.
//
// It was filed by a real sandbox buyer, through PayPal's own Resolution Centre,
// against a payment we really captured. Everything else in this app is seeded,
// because PayPal's sandbox has no disputes and no API that creates one.
//
// Two things about it are worth knowing before you change this file:
//
//  1. GET /v1/customer/disputes returns an empty list, and so does every
//     dispute_state filter. The sandbox never indexes this case. Only a direct
//     fetch by id reaches it, which is why this module takes an id rather than
//     listing.
//
//  2. The merchant has nothing to answer it with. The order was placed with
//     NO_SHIPPING, so there is no carrier, no tracking and no delivery scan.
//     That is left as it is. An agent that cannot prove delivery should say so,
//     and this case is the one that tests whether it does.

import { getDispute } from './paypal.js';
import { MERCHANT } from './fixtures.js';
import { maskEmail } from './records.js';
import { reasonLabel } from './gather.js';

const iso = (ms) => new Date(ms).toISOString();

export const REAL_DISPUTE_ID = process.env.REAL_DISPUTE_ID || 'PP-R-IQQ-10190238';

/** Build a record from the live PayPal object. Returns null if it cannot be read. */
export async function loadRealCase(env = process.env, fetchImpl = fetch) {
  let d;
  try {
    d = await getDispute(REAL_DISPUTE_ID, { env, fetchImpl });
  } catch {
    return null; // sandbox unreachable, or the case was removed: the app runs on fixtures alone
  }
  if (!d || !d.dispute_id) return null;

  const txn = (d.disputed_transactions || [])[0] || {};
  const msg = (d.messages || []).find((m) => m.posted_by === 'BUYER');
  const claim = msg?.content || '';
  const amount = d.dispute_amount?.value || txn.gross_amount?.value || '0.00';
  const email = txn.buyer?.email_address || 'buyer@personal.example.com';
  const opened = d.create_time;

  return {
    id: d.dispute_id,
    source: 'PAYPAL',
    live: true,
    fixture_key: null,
    paypal: d, // the untouched API object, so the UI can show exactly what PayPal returned
    txn: {
      id: txn.seller_transaction_id || null,
      buyer: { name: 'Sandbox buyer' },
      buyer_email: email,
      paid_at: txn.create_time || opened,
    },
    // Deliberately empty. There is no order, no shipment and no correspondence.
    merchant: { order: null, shipments: [], comms: [] },
    buyer_claim: claim,
    buyer_photos: null,
    buyer: { name: 'Sandbox buyer', email_masked: maskEmail(email) },
    item: { sku: null, name: 'Brass desk lamp, Harbour & Hale Goods' },
    reason_label: reasonLabel(d.reason),
    tz: MERCHANT.tz,
    opened_at: opened,
    // PayPal leaves seller_response_due_date null while it reviews an inquiry and
    // fills it in once the case reaches the seller. It is a key on the open-by-due
    // index, so it can never be null: until PayPal sets a date we estimate one at
    // the documented ten days and correct it on the next read.
    due_at: d.seller_response_due_date || iso(Date.parse(opened) + 10 * 864e5),
    due_estimated: !d.seller_response_due_date,
    state: 'NEW',
    outcome: null,
    analysis: null,
    filing: null,
    trace: [],
    history: [{ t: opened, actor: 'paypal', event: 'created', detail: `Filed by the buyer through the Resolution Centre. ${d.dispute_life_cycle_stage}, ${d.status}.` }],
    nudged: false,
    missed_note: null,
  };
}
