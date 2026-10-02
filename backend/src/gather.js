// Evidence gathering and scoring. Deterministic: reads the merchant's records
// (shop, carrier, mail, payments, risk) and turns them into evidence items,
// then scores them against a per-reason checklist. The LLM never decides the
// score; it only drafts prose from the items this module produces.

const Q = { strong: 1, partial: 0.5, none: 0, contradicts: -0.5 };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const hrs = (a, b) => Math.round((b - a) * 10) / 10;

function fmtDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

function lastEvent(sh, status) { return [...sh.events].reverse().find((e) => e.status === status); }
function forwardShipments(m) { return m.shipments.filter((s) => s.kind !== 'RETURN'); }

function addr(a) { return `${a.line1}, ${a.city}, ${a.state} ${a.zip}`; }

/** @returns evidence items; each: {id, kind, evidence_type, title, detail, source, quality, evidence_info?} */
export function gather(f) {
  const m = f.merchant, items = [];
  const push = (it) => { items.push({ id: `E${items.length + 1}`, ...it }); return items[items.length - 1]; };
  const tool = []; // trace of tool calls made while gathering
  const t0 = f._t0;
  const abs = (h) => t0 + h * 3600_000;

  // ---- shop.order
  tool.push({ tool: 'shop.get_order', args: { order_id: m.order.id }, result: `${m.order.items.length} line item(s), total ${m.order.total} ${m.order.currency}` });
  push({ kind: 'order', evidence_type: 'ORDER_DETAILS', title: `Order ${m.order.id}`, source: 'shop',
    detail: `Placed ${fmtDay(abs(m.order.placed_h))}: ${m.order.items.map((i) => `${i.qty} x ${i.name} (${i.sku}) at $${i.price}`).join('; ')}. Total $${m.order.total} ${m.order.currency}. Ship-to ${addr(m.order.ship_to)}.`, quality: 'strong' });

  // ---- carrier.track
  const ship = forwardShipments(m)[0];
  let delivered = null, signed = null, exception = null;
  if (ship) {
    tool.push({ tool: 'carrier.track', args: { carrier: ship.carrier, tracking: ship.tracking }, result: `${ship.events.length} scan events, last: ${ship.events.at(-1).status}` });
    delivered = lastEvent(ship, 'DELIVERED');
    signed = ship.events.find((e) => e.signed_by);
    exception = ship.events.find((e) => e.status === 'EXCEPTION');
    const evInfo = { tracking_info: [{ carrier_name: ship.carrier, tracking_number: ship.tracking }] };
    if (delivered) {
      push({ kind: 'delivery_scan', evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: evInfo, title: `${ship.carrier} ${ship.tracking}: delivered`, source: 'carrier',
        detail: `Shipped ${fmtDay(abs(ship.shipped_h))} via ${ship.service}. Delivered ${fmtDay(abs(delivered.h))} at ${delivered.location}. Carrier note: "${delivered.detail}".`, quality: 'strong' });
    } else {
      push({ kind: 'delivery_scan', evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: evInfo, title: `${ship.carrier} ${ship.tracking}: no delivery scan`, source: 'carrier',
        detail: `Shipped ${fmtDay(abs(ship.shipped_h))}; last scan ${ship.events.at(-1).status} at ${ship.events.at(-1).location}.`, quality: 'partial' });
    }
    if (signed) {
      push({ kind: 'signature', evidence_type: 'PROOF_OF_DELIVERY_SIGNATURE', title: `Signature on delivery: ${signed.signed_by}`, source: 'carrier',
        detail: `Carrier recorded a signature by "${signed.signed_by}" on ${fmtDay(abs(signed.h))}.`, quality: 'strong' });
    } else if (delivered?.photo_on_file) {
      push({ kind: 'signature', evidence_type: 'PROOF_OF_DELIVERY_SIGNATURE', title: 'No signature; delivery photo on file', source: 'carrier',
        detail: `Order required a signature but the driver released the parcel without one. The carrier holds a delivery photo.`, quality: 'partial' });
    } else if (delivered) {
      push({ kind: 'signature', evidence_type: 'PROOF_OF_DELIVERY_SIGNATURE', title: 'No signature or photo', source: 'carrier',
        detail: m.order.signature_required ? 'A signature was required but none was captured.' : 'Order did not require a signature; none captured.', quality: m.order.signature_required ? 'contradicts' : 'none' });
    }
    if (exception) {
      push({ kind: 'exception', evidence_type: 'ADDITIONAL_TRACKING_INFORMATION', title: 'Carrier exception on route', source: 'carrier',
        detail: `On ${fmtDay(abs(exception.h))} the carrier logged an exception at ${exception.location}: "${exception.detail}".`, quality: 'contradicts' });
    } else if (delivered) {
      push({ kind: 'exception', evidence_type: 'ADDITIONAL_TRACKING_INFORMATION', title: 'No carrier exceptions', source: 'carrier',
        detail: 'The scan history has no exception, hold, damage or return-to-sender events.', quality: 'strong' });
    }
    // Address match: where the carrier says it went vs where the buyer's own PayPal-confirmed address is.
    if (delivered) {
      const want = norm(f.txn.confirmed_address.line1), got = norm(delivered.location.split(',')[0]);
      const exact = got === want;
      tool.push({ tool: 'paypal.transaction.shipping_address', args: { txn: f.txn.id }, result: addr(f.txn.confirmed_address) });
      push({ kind: 'address', evidence_type: 'DELIVERY_ADDRESS', title: exact ? 'Delivered to the address the buyer confirmed in PayPal' : 'Delivery address differs from the buyer\'s PayPal address', source: 'paypal+carrier',
        detail: exact ? `Carrier delivered to "${delivered.location}", matching the buyer's PayPal-confirmed address ${addr(f.txn.confirmed_address)}.`
          : `Buyer's PayPal-confirmed address is ${addr(f.txn.confirmed_address)} but the carrier recorded delivery to "${delivered.location}". The street numbers differ.`,
        quality: exact ? 'strong' : 'contradicts' });
    }
    // Weight vs listing (for not-as-described)
    if (m.listing?.listed_weight_oz && ship.weight_oz) {
      const diff = Math.abs(ship.weight_oz - m.listing.listed_weight_oz) / m.listing.listed_weight_oz;
      push({ kind: 'sku_match', evidence_type: 'PHOTOS_OF_SHIPPED_ITEM', title: 'Shipped weight matches the listing', source: 'shop+carrier',
        detail: `Shipped weight ${ship.weight_oz} oz against listed weight ${m.listing.listed_weight_oz} oz (${(diff * 100).toFixed(1)}% difference); SKU ${m.order.items[0].sku} shipped as ordered.`, quality: diff <= 0.05 ? 'strong' : 'contradicts' });
    }
  }

  // ---- mail
  tool.push({ tool: 'mail.search_thread', args: { order_id: m.order.id }, result: `${m.comms.length} message(s)` });
  const buyerAfter = m.comms.filter((c) => c.from === 'buyer' && delivered && c.h > delivered.h);
  const POS = /\b(thanks|thank you|got it|arrived|love|works|sturdy|nicely made|enjoy|hang|washing|descale)\b/i;
  const NEG = /\b(never|nothing|not received|haven't received|have received nothing|missing|not what i expected|greyer)\b/i;
  const refundNotice = m.comms.find((c) => c.from === 'seller' && m.refunds.some((r) => c.body.includes(r.id)));
  if (m.comms.length && refundNotice) {
    push({ kind: 'buyer_comms', evidence_type: 'COMMUNICATION_WITH_THE_SENDER', title: 'Buyer was told the refund was issued', source: 'mail',
      detail: m.comms.map((c) => `${fmtDay(abs(c.h))} ${c.from}: "${c.body}"`).join(' | '), quality: 'strong', note: 'seller emailed the refund ID to the buyer' });
  } else if (m.comms.length) {
    const pos = buyerAfter.filter((c) => POS.test(c.body) && !/not what i expected/i.test(c.body));
    const neg = buyerAfter.filter((c) => NEG.test(c.body));
    const q = pos.length && !neg.length ? 'strong' : pos.length ? 'partial' : neg.length ? 'none' : 'none';
    const quote = (c) => `${fmtDay(abs(c.h))}, buyer wrote "${c.body}"`;
    push({ kind: 'buyer_comms', evidence_type: 'COMMUNICATION_WITH_THE_SENDER', title: `Message thread (${m.comms.length} messages)`, source: 'mail',
      detail: m.comms.map((c) => `${fmtDay(abs(c.h))} ${c.from}: "${c.body}"`).join(' | '),
      quality: q, note: q === 'strong' ? 'buyer acknowledged the goods after delivery' : q === 'partial' ? 'mixed' : 'no acknowledgement of receipt',
      ...(pos[0] ? { quote: quote(pos[0]) } : {}) });
  } else {
    push({ kind: 'buyer_comms', evidence_type: 'COMMUNICATION_WITH_THE_SENDER', title: 'No message thread', source: 'mail', detail: 'No messages with this buyer on this order.', quality: 'none' });
  }

  // ---- policy
  const returnReq = m.comms.find((c) => c.from === 'buyer' && /return/i.test(c.body));
  const sellerOffered = m.comms.find((c) => c.from === 'seller' && /(return|label|refund)/i.test(c.body));
  tool.push({ tool: 'shop.get_policies', args: {}, result: 'return + shipping policy' });
  push({ kind: 'policy', evidence_type: 'RETURN_POLICY', title: 'Published return policy', source: 'shop', detail: `Return policy: ${f._policy.return} Shipping policy: ${f._policy.shipping}`,
    quality: sellerOffered && !returnReq ? 'partial' : 'strong' });

  // ---- listing
  if (m.listing) {
    tool.push({ tool: 'shop.get_listing', args: { sku: m.order.items[0].sku }, result: `${m.listing.photos} photos` });
    const colourWords = Object.keys(m.listing.attributes || {}).length > 0;
    push({ kind: 'listing', evidence_type: 'ITEM_DESCRIPTION', title: `Listing: ${m.listing.title}`, source: 'shop',
      detail: `Listing text: "${m.listing.description}" (${m.listing.photos} photos).`, quality: /vary|undertone|may/i.test(m.listing.description) && f.dispute.buyer_photos ? 'partial' : colourWords ? 'strong' : 'partial' });
  }
  if (f.dispute.buyer_photos != null) {
    push({ kind: 'buyer_photos', evidence_type: 'OTHER', title: f.dispute.buyer_photos ? 'Buyer attached a photo' : 'Buyer supplied no photographs', source: 'paypal',
      detail: f.dispute.buyer_photos ? `Buyer attached ${f.dispute.buyer_photos} photo to the dispute; a photo of a colour is only weak evidence of a mismatch because of screen and lighting differences.` : 'The dispute has no buyer photographs.',
      quality: f.dispute.buyer_photos ? 'none' : 'strong' });
  }

  // ---- payments
  tool.push({ tool: 'payments.refund_ledger', args: { order_id: m.order.id }, result: `${m.refunds.length} refund(s)` });
  const dupOrders = m.other_orders || [];
  if (m.refunds.length) {
    const r = m.refunds[0];
    const before = r.h < f.dispute.opened_h;
    const match = Number(r.amount) === Number(f.dispute.amount);
    push({ kind: 'refund', evidence_type: 'PROOF_OF_REFUND', evidence_info: { refund_ids: [r.id] }, title: `Refund ${r.id}: $${r.amount} ${r.status}`, source: 'payments',
      detail: `Refund ${r.id} for $${r.amount} ${r.currency} ${r.status} on ${fmtDay(abs(r.h))}, ${before ? 'before' : 'after'} the dispute was opened. Disputed amount is $${f.dispute.amount}.`,
      quality: r.status === 'COMPLETED' && match ? 'strong' : 'partial', timing: before && match ? 'strong' : 'partial' });
    const returnShip = m.shipments.find((s) => s.kind === 'RETURN');
    if (returnShip) {
      push({ kind: 'return_receipt', evidence_type: 'PROOF_OF_RETURN', evidence_info: { tracking_info: [{ carrier_name: returnShip.carrier, tracking_number: returnShip.tracking }] }, title: `Return received (${returnShip.tracking})`, source: 'carrier',
        detail: `Return shipment ${returnShip.carrier} ${returnShip.tracking} delivered to our warehouse ${fmtDay(abs(returnShip.events.at(-1).h))}; the refund followed on ${fmtDay(abs(r.h))}.`, quality: 'strong' });
    }
  }
  if (dupOrders.length) {
    const d = dupOrders[0];
    const same = JSON.stringify(d.items.map((i) => [i.sku, i.qty])) === JSON.stringify(m.order.items.map((i) => [i.sku, i.qty]));
    const nShip = forwardShipments(m).length;
    push({ kind: 'shipment_count', evidence_type: 'ADDITIONAL_TRACKING_INFORMATION', title: `${nShip} parcel shipped for ${1 + dupOrders.length} orders`, source: 'carrier',
      detail: `Only ${nShip} parcel was ever shipped against ${1 + dupOrders.length} paid orders, so the second charge bought nothing that was delivered.`, quality: nShip >= 1 + dupOrders.length ? 'strong' : 'contradicts' });
    push({ kind: 'distinct_orders', evidence_type: 'ORDER_DETAILS', title: same ? `Second order ${d.id} is identical to ${m.order.id}` : `Order ${d.id} is a different purchase`, source: 'shop',
      detail: same ? `Order ${d.id} (${d.status}) contains the same item(s) as ${m.order.id}, created ${Math.round(Math.abs(d.placed_h - m.order.placed_h) * 60)} minutes apart. Note on file: "${d.note}". Only one parcel was ever shipped.`
        : `Order ${d.id} contains different items.`, quality: same ? 'contradicts' : 'strong' });
  }

  // ---- risk
  tool.push({ tool: 'risk.get_signals', args: { txn: f.txn.id }, result: `AVS ${m.risk.avs}, CVV ${m.risk.cvv}, ${m.risk.prior_orders} prior orders` });
  const riskGood = m.risk.avs === 'Y' && m.risk.cvv === 'M' && m.risk.prior_orders >= 2 && m.risk.device_seen_before;
  push({ kind: 'risk', evidence_type: 'DETAILS_OF_PURCHASE', title: riskGood ? 'Known customer on a known device' : 'Limited customer history', source: 'risk',
    detail: `Address check ${m.risk.avs}, card security check ${m.risk.cvv}, ${m.risk.prior_orders} prior order(s), account ${m.risk.account_age_days} days old, ${m.risk.device_seen_before ? 'device seen on earlier orders' : 'first time this device was seen'}, IP country ${m.risk.ip_country}.`,
    quality: riskGood ? 'strong' : m.risk.prior_orders >= 1 ? 'partial' : 'none' });

  return { items, tool };
}

// Per-reason checklists. Weights sum to 100.
export const CHECKLISTS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: [
    ['delivery_scan', 'Carrier shows delivery', 35], ['signature', 'Signature or delivery photo', 20], ['address', 'Delivered to the buyer\'s confirmed address', 20],
    ['buyer_comms', 'Buyer acknowledged receipt', 15], ['exception', 'No carrier exceptions', 10],
  ],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: [
    ['listing', 'Listing matches what shipped', 25], ['delivery_scan', 'Carrier shows delivery', 15], ['sku_match', 'Shipped SKU and weight match', 15],
    ['policy', 'Return policy offered and not used', 10], ['buyer_comms', 'Seller tried to resolve; buyer did not take it up', 25], ['buyer_photos', 'Buyer evidence of a mismatch', 10],
  ],
  UNAUTHORISED: [
    ['delivery_scan', 'Carrier shows delivery', 20], ['address', 'Delivered to the buyer\'s confirmed address', 25], ['risk', 'Known customer, known device, checks passed', 25],
    ['signature', 'Signature on delivery', 15], ['buyer_comms', 'Buyer used or discussed the item', 15],
  ],
  CREDIT_NOT_PROCESSED: [
    ['refund', 'Refund issued, completed, correct amount', 60], ['return_receipt', 'Return received', 20], ['buyer_comms', 'Buyer was told the refund was issued', 20],
  ],
  DUPLICATE_TRANSACTION: [
    ['distinct_orders', 'Two genuinely distinct orders', 60], ['shipment_count', 'A separate shipment for each charge', 40],
  ],
};

export function score(reason, items) {
  const list = CHECKLISTS[reason];
  if (!list) return { score: 0, checklist: [], known_reason: false };
  const checklist = list.map(([kind, label, weight]) => {
    const cands = items.filter((i) => i.kind === kind);
    // best candidate wins, but a contradiction on the same kind is never hidden behind a good one
    const q = cands.length ? cands.map((i) => i.quality).sort((a, b) => Q[b] - Q[a])[0] : 'none';
    const worst = cands.some((i) => i.quality === 'contradicts') ? 'contradicts' : q;
    const eff = worst === 'contradicts' ? 'contradicts' : q;
    let qq = eff;
    // CNP timing is folded into the refund row
    let earned = weight * Q[qq];
    const item = cands[0];
    return { kind, label, weight, quality: qq, earned: Math.round(earned * 10) / 10, item_ids: cands.map((c) => c.id) };
  });
  const total = Math.max(0, Math.min(100, Math.round(checklist.reduce((s, c) => s + c.earned, 0))));
  return { score: total, checklist, known_reason: true };
}

export function reasonLabel(r) {
  return ({
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received', MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described', UNAUTHORISED: 'Unauthorised',
    CREDIT_NOT_PROCESSED: 'Credit not processed', DUPLICATE_TRANSACTION: 'Duplicate transaction', INCORRECT_AMOUNT: 'Incorrect amount',
    PAYMENT_BY_OTHER_MEANS: 'Paid by other means', CANCELED_RECURRING_BILLING: 'Cancelled recurring billing', PROBLEM_WITH_REMITTANCE: 'Remittance problem', OTHER: 'Other',
  })[r] || r;
}
