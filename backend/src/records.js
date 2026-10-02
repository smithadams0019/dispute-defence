// Turns a fixture into a stored dispute record shaped like the PayPal Disputes API response.
import { MERCHANT } from './fixtures.js';
import { reasonLabel } from './gather.js';

const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();

const DAY = 86400_000;
/** Narrative dates (shipping scans, emails) hang off the UTC day start, so the story text is identical for every visitor all day; live deadlines hang off `anchor`. */
export const dayStart = (ms) => Math.floor(ms / DAY) * DAY;

export function createRecord(fx, anchor, { source = 'FIXTURE' } = {}) {
  const t0 = dayStart(anchor);
  const d = fx.dispute, at = (h) => iso(anchor + h * H);
  const stage = d.stage;
  const paypal = {
    dispute_id: d.id,
    create_time: at(d.opened_h), update_time: at(d.opened_h),
    reason: d.reason, status: 'WAITING_FOR_SELLER_RESPONSE', dispute_state: 'REQUIRED_ACTION',
    dispute_amount: { currency_code: 'USD', value: d.amount },
    dispute_life_cycle_stage: stage, dispute_channel: 'INTERNAL',
    seller_response_due_date: at(d.due_h),
    disputed_transactions: [{
      seller_transaction_id: fx.txn.id, create_time: at(fx.txn.paid_h), transaction_status: 'COMPLETED',
      gross_amount: { currency_code: 'USD', value: d.amount },
      buyer: { name: fx.txn.buyer.name }, seller: { name: MERCHANT.name, merchant_id: MERCHANT.paypal_merchant_id },
      items: fx.merchant.order.items.map((i) => ({ item_id: i.sku, item_description: i.name, item_quantity: String(i.qty), reason: d.reason })),
    }],
    messages: [{ posted_by: 'BUYER', time_posted: at(d.claim_h ?? d.opened_h), content: d.buyer_claim }],
    links: [{ href: `/v1/customer/disputes/${d.id}`, rel: 'self', method: 'GET' }, { href: `/v1/customer/disputes/${d.id}/provide-evidence`, rel: 'provide_evidence', method: 'POST' }, { href: `/v1/customer/disputes/${d.id}/accept-claim`, rel: 'accept_claim', method: 'POST' }],
  };
  return {
    id: d.id, source, fixture_key: fx.key, t0, anchor, opened_h: d.opened_h,
    paypal, txn: fx.txn, merchant: fx.merchant, buyer_claim: d.buyer_claim, buyer_photos: d.buyer_photos ?? null,
    buyer: { name: fx.txn.buyer.name, email_masked: maskEmail(fx.txn.buyer_email) },
    item: { sku: fx.merchant.order.items[0].sku, name: fx.merchant.order.items[0].name },
    reason_label: reasonLabel(d.reason),
    tz: MERCHANT.tz,
    opened_at: paypal.create_time, due_at: paypal.seller_response_due_date,
    state: 'NEW', outcome: null, analysis: null, filing: null, trace: [], history: [{ t: at(d.opened_h), actor: 'paypal', event: 'created', detail: `Dispute opened (${reasonLabel(d.reason)}). Response due ${paypal.seller_response_due_date}.` }],
    nudged: false, missed_note: fx.missed_note ?? null,
  };
}

export function maskEmail(e) {
  const [u, d] = e.split('@');
  return `${u[0]}${'*'.repeat(Math.max(2, u.length - 1))}@${d}`;
}
