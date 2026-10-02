# Dispute Defence

**A dispute-defence agent that fights disputes on their merits and never misses a deadline.**

Built for the PayPal AI Hackathon. Sandbox only, no real money.

- Live app: https://d3ole4luf0zv98.cloudfront.net
- Function URL (API): https://isknjuxnxkehdslkwgwmlzk2vm0jdmeu.lambda-url.us-east-1.on.aws/api/health
- Licence: MIT

## The problem

When a buyer opens a dispute, the seller has a fixed window to answer. Miss it and the dispute closes in the buyer's favour, whatever the evidence said.

PayPal's own MCP server exposes 3 dispute tools: `list_disputes`, `get_dispute` and `accept_dispute_claim`. The last is its only write, and it surrenders: the dispute closes for the buyer and the money is refunded. There is no evidence tool, no appeal, no escalate, no offer. We stood the server up and checked (see `docs/mcp-probe-output.txt`, real output).

The Disputes REST API has all of those operations: 15 in the live schema, including `provide-evidence`. This project calls the REST API directly.

## What it does

1. A dispute arrives by webhook (`CUSTOMER.DISPUTE.CREATED`). The webhook is authenticated before anything else happens.
2. A Bedrock tool-using agent (Claude Sonnet 4.5, Converse API, at most 9 turns) investigates. It chooses which records to pull: the dispute, the order, the carrier scans, the buyer's emails, the store policy, the refund ledger, the risk signals.
3. It scores the evidence against a per-reason checklist, drafts a response, and the server checks that every dollar amount, date, tracking number and ID in the draft exists in the evidence it fetched.
4. If the evidence is strong enough it files `provide-evidence`. If the evidence is too weak, or the seller is plainly at fault, the agent hands the dispute to a person with its reason. Refunds are never issued without a person.
5. A scheduled guard (every 5 minutes) watches the clock. If a person has not acted by the hand-over point, it files the best honest response rather than let the window close.

## The evidence for the mechanism

These figures are from the federal Independent Dispute Resolution operational dataset: "Supplemental Background on Federal Independent Dispute Resolution Public Use Files, January 1, 2025 - June 30, 2025", published by the Departments of Health and Human Services, Labor and the Treasury.

| Measure (1 Jan to 30 Jun 2025) | Figure |
|---|---|
| Disputes initiated | 1,186,812 (39% more than the previous half-year) |
| Disputes closed | 1,349,343 (48% more) |
| Payment determinations rendered | 1,082,247 (up about 55%) |
| Determinations within 30 business days | about 37% (401,484) |
| Determinations within 60 business days | about 67% |
| Determinations that were default decisions (one party did not respond in time) | 22% |
| Initiated disputes where eligibility was challenged | 40% |

**Provenance, stated plainly.** That dataset is US healthcare billing arbitration. It is not PayPal commerce data, and none of these figures belong to PayPal. What transfers is the mechanism: at scale, about a fifth of outcomes are decided by a missed deadline rather than by the merits.

## PayPal's MCP server, run for real

`docs/mcp-probe-output.txt` is the recorded output of `mcp-probe/probe.mjs`: PayPal's own `@paypal/mcp` server started over stdio with a real sandbox token.

- `tools/list` returns **28 tools** with `--tools=all`. The package's own CLI carries an allowlist; `@paypal/agent-toolkit` reaches more.
- Exactly **3 are dispute tools**, and the **only write is `accept_dispute_claim`**, which closes the dispute in the buyer's favour and refunds.
- Nothing in the 28 provides evidence, appeals, escalates or makes an offer.
- Remote server: the path in PayPal's quickstart, `/http`, returns **404** on `mcp.paypal.com` and `mcp.sandbox.paypal.com`. `/mcp` returns **401** (it exists and wants OAuth). `/.well-known/oauth-authorization-server` returns 200 and advertises a `registration_endpoint` (dynamic client registration).

The UI's "Surrender vs defend" page puts that next to this agent. The refund side is a preview: `accept_dispute_claim` was never called, because it moves money and the sandbox has no dispute of ours. The defend side runs on a fixture. The honest summary is that the MCP tool list is real and the comparison of outcomes is simulated.

## Live schema check

`backend/scripts/gen-enums.mjs` pulls `https://developer.paypal.com/api/customer-disputes/v1/schema.json` (version 1.12, 15 operations). Evidence types (85), carriers (1,257) and the 2,000-character note limit are validated from that file, and the live test re-fetches the schema and fails if it drifts. The schema documents `provide-evidence` only as multipart with an `evidence-file` part; the JSON `input` part this project sends is not in the machine-readable schema, so that one detail follows PayPal's integration guide and is unverified.

## What is live and what is fixture

| Part | Status |
|---|---|
| PayPal OAuth, scopes, `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}` | **Live sandbox.** The sandbox account has 0 disputes (the Disputes API has no create operation; a sandbox dispute needs a buyer in a browser). A read of an unknown id returns a real `404 RESOURCE_NOT_FOUND`. |
| `provide-evidence`, `accept-claim` against PayPal | **Not called live.** There is no dispute in the sandbox to act on, and `accept-claim` refunds a buyer. The request shape is proven against the live schema instead (see below). A successful filing was never observed. |
| Evidence request bodies | Validated against enums taken from the **live schema** (version 1.12), re-checked against the live URL in the tests. |
| Webhook registration and signature verification | **Live.** A webhook is registered with PayPal for the three dispute events. PayPal's `verify-webhook-signature` returns `FAILURE` for a forged event, and the deployed Lambda returns 401. No real dispute event has arrived, because there are no sandbox disputes. |
| PayPal MCP server | **Live.** Run locally with a real sandbox token; tool list and calls recorded. |
| Disputes in the demo board | **Fixtures.** Invented merchant, buyers, orders and carrier scans. Dispute objects follow the live schema's shape but do not exist at PayPal. |
| Filing on a fixture dispute | The exact request is **built and validated, not sent.** Every filing says `FIXTURE_DRY_RUN`. |
| Agent runs | **Real Bedrock calls.** Seeded disputes use a Bedrock run cached once per day so the first load is instant; the "Deliver webhook" button runs the agent fresh. |
| PayPal's decision after filing | **Simulated.** Labelled as such wherever it appears. |
| Demo clock | A per-visitor offset so the guard can be seen acting. The guard is the real code; the clock jump is the demo. |

## Architecture

```
Browser --> CloudFront --+--> S3 (React + Vite)
                         |
                         +--> /api/*  Lambda Function URL (Node 22, one function)
                                         |-- DynamoDB on-demand (disputes, deadlines, evidence, history; sparse index "open-by-due")
                                         |-- Bedrock Converse (Sonnet 4.5) tool-use loop
                                         |-- PayPal Disputes REST API (sandbox)
EventBridge (every 5 min) --> same Lambda --> deadline guard + seed-cache warm-up
```

- No API Gateway. The Lambda holds the PayPal secret as an encrypted environment variable.
- The agent run happens in a second asynchronous invocation, so no HTTP request waits 30 to 90 seconds.
- Every dispute is stored in DynamoDB with its deadline; there are no in-memory timers, so a cold Lambda loses nothing.
- Writes use optimistic versioning. Mutating PayPal calls carry a deterministic `PayPal-Request-Id`, and a replayed filing is suppressed.

## Accessibility and interface

Contrast ratios were computed from the actual colour tokens by `npm run contrast` in `frontend/` for both themes (`frontend/CONTRAST.md`). Every text pair clears 4.5:1; the lowest is 5.35:1. In the dark theme the countdown text measures 9.70:1 (amber on panel) and 7.33:1 (red on panel), and the dial digits 10.78:1 (amber) and 7.01:1 (red); the light theme figures are in `frontend/CONTRAST.md`. Nothing is conveyed by colour alone: each deadline says "Under 6 hours left" or "Overdue" in words with an icon. Controls are at least 28 by 28 px, body text is 13 px or larger, and `prefers-reduced-motion` is respected. The layout was checked at 360, 768, 1280 and 1920 px in light and dark with no horizontal scroll. The interface was iterated through three screenshot rounds, scored 6.5, 8 and 8.5 out of 10 (`frontend/UI-ITERATION.md`, shots in `frontend/shots/`).

## Run it

```
# tests (no cloud needed)
cd backend && npm install && npm test

# real PayPal sandbox tests (needs ../../.env with the sandbox keys)
npm run test:live

# local API + UI
STORE=memory DISABLE_LLM=1 node backend/scripts/dev-server.mjs     # API on :8791
cd frontend && npm install && npm run dev

# deploy everything (AWS CLI authenticated, account 854924711083)
./deploy.sh
```

See `TEST-RESULTS.md` for real output and `BUILD-LOG.md` for how it was built.

## What is real, and what is seeded

One dispute in this app is real. `PP-R-IQQ-10190238` was filed by a sandbox buyer
through PayPal's own Resolution Centre, against a payment we captured
(`84M12857JS087152G`, $229.00). It carries a real reason code, a real deadline and
a real two-way message thread: the buyer's complaint, and a seller reply this app
sent through `POST /v1/customer/disputes/{id}/send-message`. The UI marks it Live.

The rest of the queue is seeded, and the reason is a PayPal limitation rather than
a shortcut. **PayPal exposes no API that creates a dispute.** Only a buyer can open
one, in a browser, against a payment they made. We did that once, by hand, which is
how the real case above exists. Doing it a dozen times would need a dozen sandbox
buyers and a dozen browser sessions.

Two things that cost real time and are worth knowing:

- The dispute does not appear in `GET /v1/customer/disputes` immediately. For the
  first few minutes the list returns an empty array and every `dispute_state` filter
  returns nothing, while a direct `GET /v1/customer/disputes/{id}` returns the full
  object. Fetch by id.
- Its id carries the `PP-R-` prefix, not `PP-D-`. PayPal's buyer flow opens an
  inquiry as a message to the seller, and the id reflects that.

What is simulated, and labelled as such in the UI: the adjudication outcome. The
sandbox never decides a case, so no app can show PayPal ruling for the buyer or the
seller. `accept_claim` and `provide_evidence` are both available on the live case
and have deliberately been left unused.
