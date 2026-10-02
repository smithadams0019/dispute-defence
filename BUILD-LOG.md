# BUILD-LOG — Dispute Defence (PayPal AI Hackathon, project 2 of 5)

Running log. Newest at the bottom. Written as I go.

## 2026-10-02 — Recon (live, not assumed)
- Sandbox OAuth works. Token scopes include disputes read-seller, read-buyer, update-seller, create, documents/disputes/download.
- Live schema fetched from https://developer.paypal.com/api/customer-disputes/v1/schema.json (HTTP 200, 595 KB, info.version 1.12). Snapshot: `spec/customer-disputes-v1.schema.json`.
- Schema paths: 15 operations (list, get, patch, provide-evidence, appeal, accept-claim, adjudicate, require-evidence, escalate, send-message, make-offer, accept-offer, deny-offer, acknowledge-return-item, provide-supporting-info). Seller scope (update-seller) on 10 of them; accept-offer / deny-offer are update-buyer only.
- NOTE: the actual REST path is `/accept-claim`, not `accept_dispute_claim` (that is the MCP tool name from the brief; I did not inspect the MCP server, per instruction).
- NOTE: schema documents `provide-evidence` ONLY as multipart/form-data with an `evidence-file` part, while its description says "specify the evidence in the JSON request body". The JSON part of the multipart body (`input`) is therefore NOT in the machine-readable schema. I build `input` as application/json part + optional `evidence-file`, matching PayPal's integration guide; evidence JSON fields (evidence_type, evidence_info.tracking_info[carrier_name,tracking_number], notes<=2000) ARE validated against the live schema enums.
- GET /v1/customer/disputes on the sandbox account: 200, `items: []`. There is no create-dispute operation in the Disputes API; sandbox disputes can only be made by a buyer in a browser (no sandbox buyer credentials available). => demo runs on fixtures; live sandbox calls are listing + probing.
- provide-evidence / accept-claim against a non-existent id: 404 RESOURCE_NOT_FOUND for both JSON and multipart bodies (auth + route are real; body validation is not reached).

## Design decisions
- Lambda (Node 22, zero deps, AWS SDK v3 from runtime), Function URL, DynamoDB on-demand, CloudFront in front serving S3 (/) and Function URL (/api/*).
- Per-visitor session namespace (X-Session header) so judges cannot trample each other; TTL 10 days.
- Sparse GSI `open-by-due` = the deadline index; EventBridge every 5 min runs the guard.
- Seeded fixtures precomputed with real Bedrock output at build time; webhook-arrival demo runs the pipeline live.
- Demo clock: per-session offset so the guard can be shown acting; labelled.

## Build progress (backend)
- deadline.js, policy.js, paypal.js, gather.js, agent.js, service.js, store.js, handler.js written. 42 local tests green (unit + in-process Lambda, Bedrock disabled).
- Design change during build: hand-over point is fixed when a dispute reaches a person; a late arrival gets half of the time left (floor 1 h) instead of being auto-filed on the spot (porch case: 3h40m left -> ~1h50m human window).
- Demo clock replays the 5-minute guard across a jump; `guard: "off"` shows a human-only workflow lapsing.
- Coordinator UI direction received: sidebar + "Needs your attention" panel layout (reference image), graphite/slate shell, amber countdown accent going red only at breach, own CSS only.

## 2026-10-02 — PayPal MCP server stood up (real output in docs/mcp-probe-output.txt)
- `@paypal/mcp` stdio server with --tools=all and a real sandbox token: tools/list = 28 tools; 3 dispute tools (list_disputes, get_dispute, accept_dispute_claim); only write = accept_dispute_claim; no evidence/appeal/escalate/offer tool exists.
- Remote: /http -> 404 and /mcp -> 401 on both mcp.sandbox.paypal.com and mcp.paypal.com; /.well-known/oauth-authorization-server -> 200 with registration_endpoint (dynamic client registration).
- Through the MCP server, get_dispute and accept_dispute_claim on a non-existent id returned 403 ACTION_NOT_ALLOWED, whereas the REST API returned 404 RESOURCE_NOT_FOUND for the same id. Not explained; reported as observed.
- Deployed infra (Lambda, DynamoDB, EventBridge, S3, CloudFront) via deploy.sh. Found + fixed: Lambda passes a callback as 3rd handler arg (I had used it as env), and the installed aws CLI predates --invoked-via-function-url (SDK helper script used).
- Frontend subagent finished first pass (frontend/). Port 8791 = local dev server.
- Coordinator "go deeper": tool-using Bedrock agent loop, richer deadline engine, webhook signature verification, PayPal-Request-Id idempotency. In progress below.

## 2026-10-02 (later) — deeper pass
- Bedrock tool-using agent (src/agentloop.js): 14 tools, 9-turn cap, server-side rules the model cannot override (schema validation, grounded-fact check incl. phone/URL, filing floor 45). Real runs saved in docs/agent-runs/: porch case (score 30) -> agent escalated; duplicate-charge case (score 0) -> agent escalated recommending accept; signed delivery (score 85) -> agent filed. Single run 21-38 s; two at once 81-96 s (Bedrock throttling) -> agent now runs in an async self-invocation (webhook returns 202 in <1 s).
- Deadline engine extras: hand-over point fixed at escalation (late arrivals still get a human window), guard replay across clock jumps at 5-minute ticks, UPDATED events (new due date, new buyer message -> stale draft rebuilt; after filing -> flagged; after miss -> ignored).
- Idempotency: deterministic PayPal-Request-Id on mutating calls, replay suppression stored on the dispute, optimistic versioning (409 on stale writer).
- Webhooks: registered with PayPal (id in .aws-out/webhook_id); production path = PayPal verify-webhook-signature (real FAILURE for forged events); local RSA/CRC32 verifier unit-tested with tamper, wrong id, wrong key, bad cert host, replay window.
- Scheduled guard confirmed running in CloudWatch every 5 min; it also pre-warms today's and tomorrow's seed analyses with the real agent.
- Gap noted: Bedrock throttles under concurrent agent runs; daily cap 400 calls.

## Correction (PayPal error-log feedback)
- Early probes called ids that do not exist (404) and one id that exists but belongs to another merchant (403: the id PP-D-48201 I had invented happens to be a real sandbox dispute of someone else's). That 403 also explains the MCP "ACTION_NOT_ALLOWED" I could not account for earlier.
- Fixes: fixtures renamed from PP-D-48xxx to FX-D-48xxx so they can never collide with a real id; live tests no longer call provide-evidence or accept-claim on any id (accept-claim refunds buyers, so it is never called live); the MCP probe now only calls list_disputes. Write-path shape is proven by schema validation, not by a live call.
- Recorded outputs under docs/agent-runs and the earlier test output still show the old PP-D ids; they are kept as recorded.
- Webhook path already acknowledges fast: verify signature (one PayPal call), write event to DynamoDB, return 200. No Bedrock work happens in that request.

## UI iteration (scores, honest)
- Round 1 6.5: thin dial arc, wrapped quick-action buttons, digits touching the plate, countdown below the fold on phones.
- Round 2 8, Round 3 8.5 (dial scale, grid fixes, focus handling).
- Round 4 9 after Roger's "too much information" direction: deleted the repeated card row, five quick-action cards, per-card provenance, request paths and the package checklist from the home view; telemetry moved behind "What is real?", "How it decided", "PayPal request" and "History" disclosures. Screens: frontend/shots/round1..round4 (nothing deleted). Deployed-site screenshots at 360/768/1280/1920, light and dark: docs/screens-deployed/.

## Final state
- Fixes late in the build: agent escalating without a draft now leaves an honest template draft (so a person can edit and the guard can file); guard never calls a model; seed cache key bumped.
- Deployed and passing: 12/12 deployed tests, 72 local, 6 live PayPal.
