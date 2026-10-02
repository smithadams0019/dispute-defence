# TEST-RESULTS

All output below is pasted from real runs on 2026-10-02 (files kept in `docs/test-output/`). Failures are stated where they happened.

## What each suite touches

| Suite | Command | Touches |
|---|---|---|
| Unit + in-process Lambda | `cd backend && npm test` | Nothing external. Bedrock is switched off (`DISABLE_LLM=1`); the agent loop is driven by a scripted fake model. |
| PayPal sandbox, live | `npm run test:live` | The real PayPal sandbox (OAuth, list, read, webhook registration, `verify-webhook-signature`) and the live schema URL. |
| Deployed | `npm run test:deployed` | The deployed CloudFront URL and Function URL, real Lambda, DynamoDB, Bedrock and PayPal. |

**What was NOT tested live:** `provide-evidence` and `accept-claim` against a dispute that exists. The sandbox account has no disputes and the Disputes API cannot create one. Those requests are proven only by validating their bodies against the live schema, and by the fixture dry-run path. Early probes of these endpoints with invented ids were removed after PayPal's error log showed them as noise (see BUILD-LOG.md, Correction).

## 1. Deadline logic: timezones and boundaries (unit)

Covers: a deadline today (later today in the seller's zone is not overdue), the last millisecond of a local day vs the first millisecond of the next, now === due (expired) vs one millisecond earlier, half-hour and +14 h offsets, the US DST spring-forward (23 h) and fall-back (25 h) days, the ambiguous 01:30 on fall-back, zoneless timestamps rejected, the hand-over point, a deadline updated after a draft was written, and a deadline already passed.

```
✔ first load seeds 6 fixtures in the expected states with live deadlines (21.268485ms)
✔ guard: replayed across a clock jump, the guard files the porch case at its hand-over point, inside the window (6.605917ms)
✔ guard OFF: jump past the deadline, switch the guard on, and the dispute is lost by default and counted (11.784259ms)
✔ guard ON: the same 4-day jump loses nothing, everything unfiled is filed before it lapses (9.717068ms)
✔ human path: filing from ESCALATED with edited notes, then simulated adjudication is labelled simulated (6.491995ms)
✔ cannot file after the deadline (4.163977ms)
✔ DISPUTE.UPDATED with a new due date moves the deadline and recomputes the hand-over point (6.980348ms)
✔ dispute UPDATED after a draft exists: the stale draft is rebuilt with the new buyer message (6.287897ms)
✔ dispute UPDATED after it was already filed: nothing is refiled, the owner is told (6.203551ms)
✔ dispute UPDATED after it was missed is ignored with a history note (7.438858ms)
✔ guard files best-effort even when the agent escalated without ever drafting, and never calls a model to do it (4.39543ms)
✔ parseInstant accepts Z and offsets, rejects zoneless strings (2.871241ms)
✔ expiry boundary: now === due is expired, 1 ms earlier is not (20.571168ms)
✔ band thresholds: 6h / 24h / 72h edges (0.22782ms)
✔ deadline TODAY: later today in the seller zone is due_today, not overdue (1.322584ms)
✔ deadline today, last millisecond vs first millisecond of next local day (0.879334ms)
✔ now exactly at local midnight: a deadline 1 s later is due today (0.531696ms)
✔ half-hour and far-east offsets: Kolkata (+5:30) and Kiritimati (+14) (2.53984ms)
✔ DST fall-back day (US, 2026-11-01) is 25 h long: calendar days != ms / 24h (1.167099ms)
✔ DST spring-forward day (US, 2026-03-08) is 23 h long (0.697955ms)
✔ ambiguous local hour on fall-back: same wall-clock label, two distinct instants (1.101623ms)
✔ seller timezone is required; no silent UTC default (0.262464ms)
✔ elapsed_fraction from window (0.874353ms)
✔ humanDeadline: 10% of window clamped to [1h,12h] (0.311659ms)
✔ humanDeadline: a late arrival still gets a human window (half of what was left, floor 1h) (0.199572ms)
✔ splitDuration (0.178724ms)
✔ a PayPal rejection leaves the dispute ESCALATED and never claims it was filed (0.794948ms)
✔ terminal states never act (1.419373ms)
✔ anything unfiled at or after due is marked missed; 1 ms before is not (0.349884ms)
✔ NEW runs the agent; ANALYSED files (0.108249ms)
✔ ESCALATED: waits, nudges inside 24h, force-files at the hand-over point (0.167035ms)
✔ short window: 3h40m left, 1h hand-over floor (0.128183ms)
✔ routeByStrength thresholds (0.128599ms)
```

## 2. Full local run

```
✔ health + CORS preflight (1.909631ms)
✔ session header is required and validated (0.290344ms)
✔ unknown route is 404, bad JSON is 400 (0.244758ms)
✔ first load seeds 6 fixtures in the expected states with live deadlines (21.268485ms)
✔ every fixture is labelled FIXTURE and every filing is a dry run, never "sent" (2.780504ms)
✔ strong evidence filed itself; weak evidence waited for a person; defence never invents (2.487042ms)
✔ guard: replayed across a clock jump, the guard files the porch case at its hand-over point, inside the window (6.605917ms)
✔ guard OFF: jump past the deadline, switch the guard on, and the dispute is lost by default and counted (11.784259ms)
✔ guard ON: the same 4-day jump loses nothing, everything unfiled is filed before it lapses (9.717068ms)
✔ session isolation: another visitor gets a fresh, untouched board (3.772217ms)
✔ human path: accept is a person-only action and closes the dispute in the buyer favour (4.912508ms)
✔ human path: filing from ESCALATED with edited notes, then simulated adjudication is labelled simulated (6.491995ms)
✔ cannot file after the deadline (4.163977ms)
✔ webhook: unsigned events rejected without the demo flag; CREATED with a template runs the whole pipeline and files (10.005147ms)
✔ surrender preview mutates nothing and names the single write the MCP agent has (6.118033ms)
✔ clock endpoint rejects absurd input; reset restores seed (7.447141ms)
✔ scheduled EventBridge invocation sweeps open disputes across sessions (4.773279ms)
✔ DISPUTE.UPDATED with a new due date moves the deadline and recomputes the hand-over point (6.980348ms)
✔ dispute UPDATED after a draft exists: the stale draft is rebuilt with the new buyer message (6.287897ms)
✔ dispute UPDATED after it was already filed: nothing is refiled, the owner is told (6.203551ms)
✔ dispute UPDATED after it was missed is ignored with a history note (7.438858ms)
✔ replayed file request over HTTP: second call is an idempotent no-op (4.444895ms)
✔ webhook with PayPal signature headers is verified before anything else; a failed verification is a 401 and stores nothing (0.507815ms)
✔ optimistic locking: a stale writer gets 409 instead of silently overwriting (0.50025ms)
✔ queued path (as deployed): webhook returns 202 with the dispute in NEW; the async job then completes it; the sweeper leaves a fresh NEW alone (2.805875ms)
✔ handler routes the {job:"analyse"} self-invocation (0.130582ms)
✔ guard files best-effort even when the agent escalated without ever drafting, and never calls a model to do it (4.39543ms)
✔ weak case: the agent gathers, assesses, sees "weak" and escalates instead of filing (4.883788ms)
✔ server policy refuses a hopeless filing even if the model insists, then the model escalates (1.073582ms)
✔ strong case: gathers, drafts, files; only what it fetched is cited and scored (1.617262ms)
✔ grounding: a draft with an invented amount or tracking number is rejected, and the corrected one is accepted (0.866233ms)
✔ turn cap: a model that never decides is cut off at MAX_TURNS and the loop reports no decision (0.441199ms)
✔ duplicate charge: the agent recommends accept and the dispute waits for a person (refunds are never autonomous) (0.508199ms)
✔ budget exhausted mid-run: returns null so the caller falls back to the deterministic pipeline (0.220612ms)
✔ parseInstant accepts Z and offsets, rejects zoneless strings (2.871241ms)
✔ expiry boundary: now === due is expired, 1 ms earlier is not (20.571168ms)
✔ band thresholds: 6h / 24h / 72h edges (0.22782ms)
✔ deadline TODAY: later today in the seller zone is due_today, not overdue (1.322584ms)
✔ deadline today, last millisecond vs first millisecond of next local day (0.879334ms)
✔ now exactly at local midnight: a deadline 1 s later is due today (0.531696ms)
✔ half-hour and far-east offsets: Kolkata (+5:30) and Kiritimati (+14) (2.53984ms)
✔ DST fall-back day (US, 2026-11-01) is 25 h long: calendar days != ms / 24h (1.167099ms)
✔ DST spring-forward day (US, 2026-03-08) is 23 h long (0.697955ms)
✔ ambiguous local hour on fall-back: same wall-clock label, two distinct instants (1.101623ms)
✔ seller timezone is required; no silent UTC default (0.262464ms)
✔ elapsed_fraction from window (0.874353ms)
✔ humanDeadline: 10% of window clamped to [1h,12h] (0.311659ms)
✔ humanDeadline: a late arrival still gets a human window (half of what was left, floor 1h) (0.199572ms)
✔ splitDuration (0.178724ms)
✔ request id is deterministic per (operation, dispute, body) and changes with any of them (1.33501ms)
✔ every mutating PayPal call carries PayPal-Request-Id; reads do not (18.569216ms)
✔ a replayed filing does not send a second request to PayPal (3.148605ms)
✔ a PayPal rejection leaves the dispute ESCALATED and never claims it was filed (0.794948ms)
✔ generated enums match the saved live-schema snapshot (not a stale copy) (1.819641ms)
✔ valid delivery evidence passes (28.742422ms)
✔ bad evidence_type, bad carrier, missing tracking number, oversize notes are all caught (0.442969ms)
✔ empty payload rejected (0.103248ms)
✔ terminal states never act (1.419373ms)
✔ anything unfiled at or after due is marked missed; 1 ms before is not (0.349884ms)
✔ NEW runs the agent; ANALYSED files (0.108249ms)
✔ ESCALATED: waits, nudges inside 24h, force-files at the hand-over point (0.167035ms)
✔ short window: 3h40m left, 1h hand-over floor (0.128183ms)
✔ routeByStrength thresholds (0.128599ms)
✔ crc32 matches the standard check value (1.012152ms)
✔ a correctly signed payload verifies locally (2.975672ms)
✔ REJECTED: tampered body (amount changed after signing) (0.834072ms)
✔ REJECTED: signature made for another webhook id (0.70752ms)
✔ REJECTED: signature from a different key (16.250999ms)
✔ REJECTED: cert url on a non-PayPal host or plain http (certificate substitution) (2.180703ms)
✔ REJECTED: replayed old transmission (outside the one-hour window) (0.670667ms)
✔ REJECTED: missing headers, unsupported SHA1 algo, unknown webhook id (1.1194ms)
✔ verifyViaApi posts the documented body and maps SUCCESS / FAILURE (28.371458ms)
ℹ tests 72
ℹ pass 72
ℹ fail 0
```

## 3. PayPal sandbox, live (real network)

```
  scopes: disputes/read-buyer, disputes/update-seller, disputes/read-seller, disputes/create, documents/disputes/download
✔ OAuth token carries the seller dispute scopes (1861.813036ms)
  live schema version: 1.12 | paths: 14 | saved snapshot version: 1.12
✔ LIVE schema (fetched now) still matches the enums this build validates against (2321.664043ms)
  sandbox disputes visible to this app: 0
✔ list disputes: HTTP 200 and a well-formed (possibly empty) page (890.281772ms)
   PayPal GET /v1/customer/disputes/DD-NOT-A-REAL-DISPUTE -> HTTP 404 RESOURCE_NOT_FOUND The specified resource does not exist. | debug_id f871153aaa26f
✔ read one dispute: a missing id is a clean 404 RESOURCE_NOT_FOUND (route + auth are real) (945.431859ms)
  webhook 19J57785GN615300R -> https://isknjuxnxkehdslkwgwmlzk2vm0jdmeu.lambda-url.us-east-1.on.aws/api/webhooks/paypal CUSTOMER.DISPUTE.CREATED, CUSTOMER.DISPUTE.RESOLVED, CUSTOMER.DISPUTE.UPDATED
✔ webhook is registered with PayPal for the three dispute events (1942.377655ms)
  result: {"ok":false,"reason":"PayPal verification_status FAILURE","via":"paypal-api"}
✔ PayPal ITSELF rejects a forged webhook: verify-webhook-signature returns FAILURE (1061.529755ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

## 4. PayPal's MCP server, run for real

Full file: `docs/mcp-probe-output.txt`.

```
MCP server connected. tools/list returned 28 tools via the CLI (--tools=all).

Dispute tools (3):
  - list_disputes: 
    input: ["disputed_transaction_id","dispute_state","page_size","page"]  required: []
  - get_dispute: 
    input: ["dispute_id"]  required: ["dispute_id"]
  - accept_dispute_claim: 
    input: ["dispute_id","note"]  required: ["dispute_id","note"]

Of those, WRITE tools: accept_dispute_claim
Any tool anywhere mentioning evidence/appeal/escalate/offer: []

--- one live read through the MCP server (list first; no calls on ids that are not ours)
list_disputes -> ["{\"items\":[],\"links\":[{\"href\":\"https://api.sandbox.paypal.com/v1/customer/disputes\",\"rel\":\"self\",\"method\":\"GET\"},{\"href\":\"https://api.sandbox.paypal.com/v1/customer/disputes\",\"rel\":\"first\",\"method\":\"GET\"}]}"]
get_dispute / accept_dispute_claim were NOT called: the sandbox account has no disputes, and accept_dispute_claim refunds the buyer.


--- remote MCP endpoint probe (2026-10-02T02:07:13Z)
mcp.sandbox.paypal.com/http -> 404
mcp.sandbox.paypal.com/mcp -> 401
mcp.sandbox.paypal.com/.well-known/oauth-authorization-server -> 200
mcp.paypal.com/http -> 404
mcp.paypal.com/mcp -> 401
mcp.paypal.com/.well-known/oauth-authorization-server -> 200
```

All 28 tool names are in that file; none of them provides evidence, appeals, escalates or makes an offer.

## 5. The tool-using agent against real Bedrock

Recorded runs in `docs/agent-runs/*.json` (full trace, draft and decision). These ran before the fixtures were renamed from `PP-D-48xxx` to `FX-D-48xxx`, so the ids inside them are the old ones.

| Fixture | Evidence score | Agent decision | Turns | Wall time |
|---|---|---|---|---|
| Item not received, signed delivery | 85 (strong) | Filed | 6 | 38 s (alone), 21 s (deployed, quiet) |
| Item not received, porch delivery to the wrong street number | 30 (weak) | **Escalated** (recommended accept) | 5 | 96 s (two runs at once, Bedrock throttled) |
| Duplicate charge, merchant at fault | 0 (weak) | **Escalated** (recommended accept) | 5 | 81 s (two runs at once) |

The porch case, in the agent's words: "Package was delivered to wrong address (1402 Linden Ave instead of buyer's confirmed 1420 Linden Ave). Carrier also released without required signature. Buyer legitimately did not receive the item." It declined to file.

**Stated gap:** under concurrent load Bedrock throttled the account (`Too many requests`). In one early run the agent loop failed after four turns and the system fell back to the deterministic pipeline, which still produced a valid filing. The fallback is visible in the trace. Throttling is the main operational risk for judging.

## 6. Deployed stack (CloudFront + Function URL + DynamoDB + Bedrock + PayPal)

URLs: https://d3ole4luf0zv98.cloudfront.net and https://isknjuxnxkehdslkwgwmlzk2vm0jdmeu.lambda-url.us-east-1.on.aws/

```
   https://isknjuxnxkehdslkwgwmlzk2vm0jdmeu.lambda-url.us-east-1.on.aws 200 {"ok":true,"service":"dispute-defence","now":"2026-10-02T02:29:03.566Z","model":"us.anthropic.claude-sonnet-4-5-20250929-v1:0","store":"dynamodb"}
✔ Function URL /api/health responds (1970.491328ms)
   https://d3ole4luf0zv98.cloudfront.net 200 text/html; charset=utf-8 998 bytes
✔ CloudFront serves the single-page app HTML (1568.133662ms)
✔ CloudFront routes /api/* to the Lambda (same origin, X-Session forwarded) (2821.66391ms)
   {"api":"https://api-m.sandbox.paypal.com","mode":"sandbox","oauth":"ok","dispute_scopes":["disputes/read-buyer","disputes/update-seller","disputes/read-seller","disputes/create","documents/disputes/download"],"list_status":"HTTP 200","sandbox_disputes":0,"schema":{"version":"1.12","operations":15,"source":"https://developer.p
✔ PayPal sandbox status through the deployed Lambda: oauth ok, seller scopes present (1250.091788ms)
✔ missing or malformed session header is rejected (2443.592477ms)
✔ two visitors do not see each other's changes (DynamoDB isolation) (4492.333704ms)
✔ state persists across requests (a reload finds the same board) (3584.065083ms)
  acted: ["FX-D-48213 file_best_effort","FX-D-48219 nudge_human","FX-D-48219 file_best_effort"]
✔ guard replay through the deployed stack: 4-day jump, guard on, nothing missed (2732.082784ms)
  missed with guard off: 2
✔ guard OFF through the deployed stack: the same jump loses disputes by default (2988.230903ms)
   401 {"error":"webhook rejected: PayPal verification_status FAILURE"}
✔ FORGED PayPal webhook is rejected with 401 by the deployed Lambda (verified by PayPal) (877.14884ms)
✔ unsigned webhook without the demo flag is rejected (591.838916ms)
  ack in 780 ms: 202 {"dispute_id":"FX-D-48301","state":"NEW","queued":true}
  finished after 37 s: state FILED score 85 turns 6 decided_by agent
  filing: FIXTURE_DRY_RUN /v1/customer/disputes/FX-D-48301/provide-evidence request_id dd-ea09bbf0f6fa2457acde80cba145f5c9c510bb535ba52281
✔ REAL AGENT, deployed: webhook returns 202 at once, then the Bedrock tool-using agent finishes the dispute (38343.436234ms)
ℹ tests 12
ℹ pass 12
ℹ fail 0
```

An earlier deployed run (before the fixes recorded in BUILD-LOG.md) had two failures, both genuine:
1. The guard-on clock jump returned nothing after 61 s. Cause: the agent had escalated without drafting, so the guard tried to call the model to build a draft. Fixed: the guard never calls a model; it builds from the evidence on hand. Regression test added.
2. The deployed agent run finished in 98 s with no agent summary, because Bedrock throttled while the cache warm-up was running. The final run above passed in 38 s.

## 7. Responsive and accessibility checks

- Layout checked at 360, 768, 1280 and 1920 px, light and dark, against the deployed site: no horizontal overflow at any of the eight combinations (`frontend/scripts/shoot-deployed.mjs`, screenshots in `docs/screens-deployed/`).
- Contrast, computed from the real colour tokens in both themes (`npm run contrast`, full table in `frontend/CONTRAST.md`):

```
All pairs pass
pass   5.35:1  Muted text on red panel
pass   5.37:1  Muted text on page
pass   5.73:1  Muted text on raised panel
pass   5.79:1  Muted text on amber panel
pass   5.92:1  Good text on page
...
All pairs pass
```

- Interface iteration: 6.5, then 8, then 8.5, then 9 out of 10 after a deletion pass (`frontend/UI-ITERATION.md`; screenshots for each round in `frontend/shots/round1` to `round4`).
- Click-through: 41 interactive checks against the dev API, all passing (list in `frontend/UI-ITERATION.md`). Not re-run against the deployed site.

## 8. Known gaps

- No filing was ever accepted by PayPal. Every filing in the demo is a fixture dry run.
- PayPal's decision after filing is simulated.
- Webhook signature verification was tested for rejection (real PayPal `FAILURE`, 401 from the deployed Lambda). A genuine signed event has never arrived, so the acceptance path is covered only by unit tests with a generated key.
- The local RSA/CRC32 verifier is not wired into the Lambda; the Lambda uses PayPal's verify endpoint. The local verifier does not validate the certificate chain to a PayPal root.
- Text zoom to 200% was checked by layout at narrow widths, not by browser zoom.
- Bedrock throttling under concurrent agent runs (see section 5).
