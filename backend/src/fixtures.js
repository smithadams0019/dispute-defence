// SEEDED FIXTURES. Everything in this file is invented: the merchant, the buyers,
// the orders, the carrier scans. The PayPal dispute objects follow the shape of
// the live Disputes schema, but they do not exist in PayPal. The UI and README
// say so. Times are hours relative to the moment of seeding (t0).
//
// One case in the app is not from here. real-case.js fetches PP-R-IQQ-10190238,
// a dispute a sandbox buyer actually filed against a payment we actually
// captured. It is marked Live in the UI.

export const MERCHANT = {
  name: 'Harbour & Hale Goods',
  tz: 'America/Chicago',
  paypal_merchant_id: 'FIXTURE-MERCHANT-0001',
  policies: {
    return: 'Returns accepted within 30 days of delivery for unused items in original packaging. Buyer pays return shipping unless the item is faulty or not as described. Refunds are issued to the original payment method within 3 business days of the return arriving.',
    shipping: 'Orders over $75 ship with signature required. Orders under $75 ship without signature. Tracking is emailed at dispatch.',
  },
};

const H = 3600_000;
const iso = (t0, h) => new Date(t0 + h * H).toISOString();

const ADDR = {
  okafor: { name: 'Rosalind Okafor', line1: '88 Marlowe Court', city: 'Madison', state: 'WI', zip: '53703' },
  brandt: { name: 'Tomasz Brandt', line1: '1420 Linden Ave', city: 'Evanston', state: 'IL', zip: '60201' },
  venkat: { name: 'Priya Venkataraman', line1: '2207 Alder Street, Apt 4', city: 'Austin', state: 'TX', zip: '78702' },
  whitlock: { name: 'Devon Whitlock', line1: '41 Cresswell Road', city: 'Portland', state: 'OR', zip: '97214' },
  aubry: { name: 'Marguerite Aubry', line1: '905 Hollis Street', city: 'Boston', state: 'MA', zip: '02118' },
  reyes: { name: 'Callum Reyes', line1: '312 Beacon Row', city: 'Denver', state: 'CO', zip: '80206' },
  ito: { name: 'Hana Ito', line1: '17 Fenwick Lane', city: 'Seattle', state: 'WA', zip: '98103' },
  castellanos: { name: 'Jerome Castellanos', line1: '560 Quarry Drive', city: 'Raleigh', state: 'NC', zip: '27606' },
};

/**
 * Each fixture: PayPal-shaped dispute + the merchant's own records (shop, carrier, mail, payments, risk).
 * `seed` says what state the demo starts in.
 */
export function buildFixtures(t0) {
  const T = (h) => iso(t0, h);
  const fx = [];

  // 1. THE HERO. Item not received; signed for. Filed already, awaiting PayPal.
  fx.push({
    key: 'inr-signed-walnut', seed: { state: 'FILED', filed_h: -57.4, via: 'agent' },
    dispute: { id: 'FX-D-48201', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'CHARGEBACK', amount: '184.00', opened_h: -58, due_h: 52,
      buyer_claim: 'I never received my order. The tracking says delivered but nothing came. I want my money back.', claim_h: -58.5 },
    txn: { id: '7XK41730LT229044B', paid_h: -240, buyer: ADDR.okafor, buyer_email: 'r.okafor@example.com', confirmed_address: ADDR.okafor },
    merchant: {
      order: { id: 'HH-20417', placed_h: -240.2, items: [{ sku: 'SHL-WAL-3', name: 'Walnut Floating Shelf Set (3 pc)', qty: 1, price: '184.00' }], ship_to: ADDR.okafor, total: '184.00', currency: 'USD', signature_required: true },
      shipments: [{ carrier: 'FEDEX', tracking: '774612308811', service: 'FedEx Home Delivery', shipped_h: -236, weight_oz: 318,
        events: [
          { h: -236, status: 'PICKED_UP', location: 'Milwaukee, WI', detail: 'Picked up' },
          { h: -190, status: 'IN_TRANSIT', location: 'Chicago, IL', detail: 'Departed FedEx hub' },
          { h: -140, status: 'OUT_FOR_DELIVERY', location: 'Madison, WI', detail: 'On FedEx vehicle for delivery' },
          { h: -134.5, status: 'DELIVERED', location: '88 Marlowe Court, Madison, WI 53703', detail: 'Delivered, signature obtained', signed_by: 'R OKAFOR' },
        ] }],
      comms: [
        { h: -239, from: 'seller', subject: 'Your order HH-20417 is confirmed', body: 'Thanks Rosalind. Your shelf set ships tomorrow with FedEx and needs a signature on delivery.' },
        { h: -133, from: 'seller', subject: 'Delivered: HH-20417', body: 'FedEx shows your shelf set was delivered and signed for at 88 Marlowe Court. Enjoy!' },
      ],
      refunds: [],
      risk: { avs: 'Y', cvv: 'M', prior_orders: 2, account_age_days: 611, device_seen_before: true, ip_country: 'US' },
      listing: { title: 'Walnut Floating Shelf Set (3 pc)', description: 'Three solid walnut floating shelves, 24 in, 18 in and 12 in, with hidden steel brackets. Natural oil finish.', listed_weight_oz: 320, photos: 6, attributes: { wood: 'walnut', pieces: 3 } },
    },
  });

  // 2. Not as described. Moderate. Filed by the agent.
  fx.push({
    key: 'snad-indigo-throw', seed: { state: 'FILED', filed_h: -20.2, via: 'agent' },
    dispute: { id: 'FX-D-48207', reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', stage: 'INQUIRY', amount: '62.50', opened_h: -22, due_h: 31,
      buyer_claim: 'The colour is nothing like the listing. It is grey, not indigo. I attached a photo.', claim_h: -22.5, buyer_photos: 1 },
    txn: { id: '3NB88219AC017733K', paid_h: -170, buyer: ADDR.venkat, buyer_email: 'priya.v@example.com', confirmed_address: ADDR.venkat },
    merchant: {
      order: { id: 'HH-20388', placed_h: -170.3, items: [{ sku: 'THR-IND-5060', name: 'Indigo Linen Throw 50x60', qty: 1, price: '62.50' }], ship_to: ADDR.venkat, total: '62.50', currency: 'USD', signature_required: false },
      shipments: [{ carrier: 'UPS', tracking: '1Z84R9230367194402', service: 'UPS Ground', shipped_h: -166, weight_oz: 31,
        events: [
          { h: -166, status: 'PICKED_UP', location: 'Milwaukee, WI', detail: 'Origin scan' },
          { h: -110, status: 'IN_TRANSIT', location: 'Dallas, TX', detail: 'Departed facility' },
          { h: -82, status: 'DELIVERED', location: '2207 Alder Street, Austin, TX 78702', detail: 'Delivered, left at front door' },
        ] }],
      comms: [
        { h: -48, from: 'buyer', subject: 'Colour', body: 'Hi, the throw arrived. It looks greyer than the photos on the site. Not what I expected.' },
        { h: -46, from: 'seller', subject: 'Re: Colour', body: 'Sorry it is not what you hoped for, Priya. The listing describes this as a deep blue with a grey undertone, and colours can read differently on screen. You are inside our 30-day return window, so I can send a prepaid label if you would like to return it.' },
        { h: -40, from: 'buyer', subject: 'Re: Colour', body: 'I will think about it. It is nicely made at least.' },
      ],
      refunds: [],
      risk: { avs: 'Y', cvv: 'M', prior_orders: 0, account_age_days: 95, device_seen_before: false, ip_country: 'US' },
      listing: { title: 'Indigo Linen Throw 50x60', description: 'Stonewashed European linen throw in Indigo, a deep blue with a soft grey undertone. Colours may vary slightly between screens.', listed_weight_oz: 32, photos: 4, attributes: { colour: 'Indigo', material: 'linen' } },
    },
  });

  // 3. Item not received, porch delivery, address digit mismatch. Weak. A person must decide. ~3h40m left.
  fx.push({
    key: 'inr-porch-skillet', seed: { state: 'ESCALATED', analysed_h: -0.3 },
    dispute: { id: 'FX-D-48213', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'CHARGEBACK', amount: '229.00', opened_h: -238, due_h: 3 + 40 / 60,
      buyer_claim: 'Tracking says delivered six days ago and there is nothing here. I asked the neighbours. I want a refund.', claim_h: -239 },
    txn: { id: '9DM20418WP551207H', paid_h: -420, buyer: ADDR.brandt, buyer_email: 'tbrandt@example.com', confirmed_address: ADDR.brandt },
    merchant: {
      order: { id: 'HH-20301', placed_h: -420.4, items: [{ sku: 'SKT-CI-SET3', name: 'Cast Iron Skillet Set (3 pc)', qty: 1, price: '229.00' }], ship_to: ADDR.brandt, total: '229.00', currency: 'USD', signature_required: true },
      shipments: [{ carrier: 'FEDEX', tracking: '774609881246', service: 'FedEx Ground', shipped_h: -414, weight_oz: 712,
        events: [
          { h: -414, status: 'PICKED_UP', location: 'Milwaukee, WI', detail: 'Picked up' },
          { h: -360, status: 'IN_TRANSIT', location: 'Chicago, IL', detail: 'Departed FedEx hub' },
          { h: -350, status: 'EXCEPTION', location: 'Evanston, IL', detail: 'Signature unavailable. Driver note: released without signature per delivery instructions on file' },
          { h: -349, status: 'DELIVERED', location: '1402 Linden Ave, Evanston, IL 60201', detail: 'Delivered, front porch. Photo on file', photo_on_file: true },
        ] }],
      comms: [
        { h: -419, from: 'seller', subject: 'Order HH-20301 confirmed', body: 'Thanks Tomasz. Your skillet set ships tomorrow. A signature is required on delivery.' },
        { h: -240, from: 'buyer', subject: 'Where is my order', body: 'Tracking says delivered but I have received nothing. Please help.' },
        { h: -236, from: 'seller', subject: 'Re: Where is my order', body: 'I am sorry, Tomasz. FedEx shows a porch delivery. Please check with neighbours and the carrier, and I will open a trace with FedEx.' },
      ],
      refunds: [],
      risk: { avs: 'Y', cvv: 'M', prior_orders: 1, account_age_days: 340, device_seen_before: true, ip_country: 'US' },
      listing: { title: 'Cast Iron Skillet Set (3 pc)', description: 'Pre-seasoned 8, 10 and 12 inch cast iron skillets.', listed_weight_oz: 716, photos: 5, attributes: { pieces: 3 } },
    },
  });

  // 4. Duplicate charge, and the merchant did double-charge. The agent should NOT fight this.
  fx.push({
    key: 'dup-planter', seed: { state: 'ESCALATED', analysed_h: -4 },
    dispute: { id: 'FX-D-48219', reason: 'DUPLICATE_TRANSACTION', stage: 'INQUIRY', amount: '48.00', opened_h: -30, due_h: 70,
      buyer_claim: 'I was charged twice for the same planter, three minutes apart. I only wanted one.', claim_h: -30.5 },
    txn: { id: '5RT66120NH884419C', paid_h: -96, buyer: ADDR.whitlock, buyer_email: 'devon.w@example.com', confirmed_address: ADDR.whitlock },
    merchant: {
      order: { id: 'HH-20402', placed_h: -96.05, items: [{ sku: 'PLT-CER-M', name: 'Glazed Ceramic Planter, medium', qty: 1, price: '48.00' }], ship_to: ADDR.whitlock, total: '48.00', currency: 'USD', signature_required: false },
      other_orders: [{ id: 'HH-20403', placed_h: -96.0, items: [{ sku: 'PLT-CER-M', name: 'Glazed Ceramic Planter, medium', qty: 1, price: '48.00' }], total: '48.00', status: 'NOT_SHIPPED', note: 'Created by checkout retry after a timeout' }],
      shipments: [{ carrier: 'USPS', tracking: '9400111899223450018823', service: 'USPS Ground Advantage', shipped_h: -90, weight_oz: 52,
        events: [
          { h: -90, status: 'PICKED_UP', location: 'Milwaukee, WI', detail: 'Accepted' },
          { h: -30, status: 'DELIVERED', location: '41 Cresswell Road, Portland, OR 97214', detail: 'Delivered to mailbox' },
        ] }],
      comms: [
        { h: -29, from: 'buyer', subject: 'Charged twice', body: 'I see two charges of $48.00 on the same day and only one planter arrived. Can you refund the second one?' },
      ],
      refunds: [],
      risk: { avs: 'Y', cvv: 'M', prior_orders: 3, account_age_days: 802, device_seen_before: true, ip_country: 'US' },
      listing: { title: 'Glazed Ceramic Planter, medium', description: 'Hand-glazed stoneware planter with drainage hole.', listed_weight_oz: 52, photos: 3, attributes: {} },
    },
  });

  // 5. Credit not processed, but the refund WAS issued. Strong. Filed.
  fx.push({
    key: 'cnp-refunded-kettle', seed: { state: 'FILED', filed_h: -9.6, via: 'agent' },
    dispute: { id: 'FX-D-48224', reason: 'CREDIT_NOT_PROCESSED', stage: 'INQUIRY', amount: '95.00', opened_h: -10, due_h: 118,
      buyer_claim: 'I returned the kettle two weeks ago and was told I would be refunded. I have not seen any money.', claim_h: -10.5 },
    txn: { id: '2HQ73490VD660215M', paid_h: -700, buyer: ADDR.aubry, buyer_email: 'm.aubry@example.com', confirmed_address: ADDR.aubry },
    merchant: {
      order: { id: 'HH-20155', placed_h: -700.2, items: [{ sku: 'KTL-EN-1L', name: 'Enamel Stovetop Kettle 1L', qty: 1, price: '95.00' }], ship_to: ADDR.aubry, total: '95.00', currency: 'USD', signature_required: true },
      shipments: [
        { carrier: 'UPS', tracking: '1Z84R9230367188810', service: 'UPS Ground', shipped_h: -690, weight_oz: 60, events: [{ h: -690, status: 'PICKED_UP', location: 'Milwaukee, WI', detail: 'Origin scan' }, { h: -620, status: 'DELIVERED', location: '905 Hollis Street, Boston, MA 02118', detail: 'Delivered, signature obtained', signed_by: 'M AUBRY' }] },
        { carrier: 'USPS', tracking: '9400111899223450099101', service: 'Return label', kind: 'RETURN', shipped_h: -430, weight_oz: 60, events: [{ h: -430, status: 'PICKED_UP', location: 'Boston, MA', detail: 'Return accepted' }, { h: -372, status: 'DELIVERED', location: 'Milwaukee, WI', detail: 'Return delivered to warehouse' }] },
      ],
      comms: [
        { h: -440, from: 'buyer', subject: 'Return request', body: 'The handle is wobbly. Can I return the kettle?' },
        { h: -438, from: 'seller', subject: 'Re: Return request', body: 'Of course. Prepaid label attached. We refund within 3 business days of the kettle arriving.' },
        { h: -350, from: 'seller', subject: 'Your refund has been issued', body: 'Your $95.00 refund (ID 8LU92715XB5532061) was issued to your PayPal account. It can take a few days to show on your statement.' },
      ],
      refunds: [{ id: '8LU92715XB5532061', h: -351, amount: '95.00', currency: 'USD', status: 'COMPLETED' }],
      risk: { avs: 'Y', cvv: 'M', prior_orders: 1, account_age_days: 220, device_seen_before: true, ip_country: 'US' },
      listing: { title: 'Enamel Stovetop Kettle 1L', description: 'Enamel-on-steel kettle, 1 litre.', listed_weight_oz: 60, photos: 4, attributes: {} },
    },
  });

  // 6. THE ONE THAT WAS LOST BY DEFAULT. Evidence existed. Nobody filed. This is the failure the product fixes.
  fx.push({
    key: 'inr-missed-lantern', seed: { state: 'MISSED', closed_h: -49 },
    dispute: { id: 'FX-D-48155', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'CHARGEBACK', amount: '77.00', opened_h: -265, due_h: -50,
      buyer_claim: 'Never arrived. Please refund.', claim_h: -265.5 },
    txn: { id: '6WZ10382KG910027P', paid_h: -420, buyer: ADDR.reyes, buyer_email: 'callum.r@example.com', confirmed_address: ADDR.reyes },
    merchant: {
      order: { id: 'HH-20244', placed_h: -420.3, items: [{ sku: 'LAN-BRS-L', name: 'Brass Hurricane Lantern, large', qty: 1, price: '77.00' }], ship_to: ADDR.reyes, total: '77.00', currency: 'USD', signature_required: true },
      shipments: [{ carrier: 'FEDEX', tracking: '774608120093', service: 'FedEx Home Delivery', shipped_h: -414, weight_oz: 88,
        events: [
          { h: -414, status: 'PICKED_UP', location: 'Milwaukee, WI', detail: 'Picked up' },
          { h: -300, status: 'OUT_FOR_DELIVERY', location: 'Denver, CO', detail: 'On FedEx vehicle for delivery' },
          { h: -296, status: 'DELIVERED', location: '312 Beacon Row, Denver, CO 80206', detail: 'Delivered, signature obtained', signed_by: 'C REYES' },
        ] }],
      comms: [
        { h: -295, from: 'seller', subject: 'Delivered: HH-20244', body: 'FedEx shows your lantern was signed for at 312 Beacon Row.' },
        { h: -280, from: 'buyer', subject: 'Re: Delivered', body: 'Oh. My partner may have signed for it, I will ask.' },
      ],
      refunds: [],
      risk: { avs: 'Y', cvv: 'M', prior_orders: 2, account_age_days: 500, device_seen_before: true, ip_country: 'US' },
      listing: { title: 'Brass Hurricane Lantern, large', description: 'Solid brass lantern with glass chimney.', listed_weight_oz: 88, photos: 3, attributes: {} },
    },
    missed_note: 'The dispute email landed in a shared inbox over a weekend. Nobody opened it before the window closed.',
  });

  return fx;
}

/** Disputes that "arrive by webhook" in the live demo. Not seeded; created on demand. */
export function incomingTemplates(t0, n = 0) {
  const T = (h) => iso(t0, h);
  const id = (base) => `FX-D-${base + n}`;
  return {
    'inr-signed': {
      key: 'inr-signed-duvet', seed: { state: 'NEW' },
      dispute: { id: id(48301), reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'CHARGEBACK', amount: '146.00', opened_h: 0, due_h: 240,
        buyer_claim: 'The tracking says delivered but the package is not here. I have checked everywhere. Refund me please.', claim_h: -0.1 },
      txn: { id: '4AC55210XM119806T', paid_h: -200, buyer: ADDR.ito, buyer_email: 'hana.ito@example.com', confirmed_address: ADDR.ito },
      merchant: {
        order: { id: 'HH-20466', placed_h: -200.2, items: [{ sku: 'DUV-LIN-Q', name: 'Stonewashed Linen Duvet Cover, queen', qty: 1, price: '146.00' }], ship_to: ADDR.ito, total: '146.00', currency: 'USD', signature_required: true },
        shipments: [{ carrier: 'FEDEX', tracking: '774613552078', service: 'FedEx Home Delivery', shipped_h: -196, weight_oz: 74,
          events: [
            { h: -196, status: 'PICKED_UP', location: 'Milwaukee, WI', detail: 'Picked up' },
            { h: -150, status: 'IN_TRANSIT', location: 'Minneapolis, MN', detail: 'Departed FedEx hub' },
            { h: -101, status: 'DELIVERED', location: '17 Fenwick Lane, Seattle, WA 98103', detail: 'Delivered, signature obtained', signed_by: 'H ITO' },
          ] }],
        comms: [
          { h: -100, from: 'seller', subject: 'Delivered: HH-20466', body: 'FedEx shows your duvet cover was signed for at 17 Fenwick Lane.' },
        ],
        refunds: [],
        risk: { avs: 'Y', cvv: 'M', prior_orders: 3, account_age_days: 904, device_seen_before: true, ip_country: 'US' },
        listing: { title: 'Stonewashed Linen Duvet Cover, queen', description: 'European flax linen duvet cover, queen.', listed_weight_oz: 75, photos: 5, attributes: {} },
      },
    },
    'unauthorised': {
      key: 'unauth-espresso', seed: { state: 'NEW' },
      dispute: { id: id(48302), reason: 'UNAUTHORISED', stage: 'CHARGEBACK', amount: '312.00', opened_h: 0, due_h: 240,
        buyer_claim: 'I do not recognise this purchase. I did not authorise it.', claim_h: -0.1 },
      txn: { id: '8PP90412NA770135D', paid_h: -150, buyer: ADDR.castellanos, buyer_email: 'j.castellanos@example.com', confirmed_address: ADDR.castellanos },
      merchant: {
        order: { id: 'HH-20471', placed_h: -150.1, items: [{ sku: 'ESP-LVR-1', name: 'Manual Lever Espresso Machine', qty: 1, price: '312.00' }], ship_to: ADDR.castellanos, total: '312.00', currency: 'USD', signature_required: true },
        shipments: [{ carrier: 'UPS', tracking: '1Z84R9230367201156', service: 'UPS Ground', shipped_h: -145, weight_oz: 420,
          events: [
            { h: -145, status: 'PICKED_UP', location: 'Milwaukee, WI', detail: 'Origin scan' },
            { h: -60, status: 'DELIVERED', location: '560 Quarry Drive, Raleigh, NC 27606', detail: 'Delivered, signature obtained', signed_by: 'J CASTELLANOS' },
          ] }],
        comms: [
          { h: -55, from: 'buyer', subject: 'Question about descaling', body: 'The machine arrived. How often should I descale it with hard water?' },
          { h: -54, from: 'seller', subject: 'Re: Question about descaling', body: 'Every 6 to 8 weeks with hard water. Citric acid works well.' },
        ],
        refunds: [],
        risk: { avs: 'Y', cvv: 'M', prior_orders: 4, account_age_days: 1210, device_seen_before: true, ip_country: 'US' },
        listing: { title: 'Manual Lever Espresso Machine', description: 'Lever espresso machine.', listed_weight_oz: 424, photos: 6, attributes: {} },
      },
    },
  };
}
