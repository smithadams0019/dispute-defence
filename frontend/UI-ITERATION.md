# UI iteration log

Preview loop: Vite dev server driven by Playwright (Chromium, --no-sandbox) against the dev API on port 8791.
Screens shot at 360, 768, 1280 and 1920 wide in light and dark: home, all disputes, the evidence, compare, dispute detail, the file confirmation, plus the countdown in five states (critical, soon, urgent, breached, comfortable). Files: `shots/round1`, `shots/round2`, `shots/round3` (before/after kept). Re-run with `node scripts/shoot.mjs <round>`.

## Round 1: 6.5 / 10
- The dial arc was a thin sliver for any dispute with a long window, so the signature element looked empty.
- Quick-action cards wrapped the three advance buttons onto two lines and left uneven empty space.
- Breached digits (01:20:50) nearly touched the edge of the dial plate.
- On phones the simulate box pushed the countdown below the first screen.
- Hierarchy, spacing scale and type scale were already consistent; both themes passed contrast.

## Round 2: 8 / 10
- Dial now fills across the last 72 hours, so 3 hours left reads as nearly empty and 60 hours as most of the way round.
- Digit size reduced so breached values sit inside the plate.
- Quick actions use a six-column grid; the clock card spans two columns so its three buttons sit on one line; buttons align to the bottom.
- On phones the attention panel and dial come first, the simulate box second.
- Found by the click-through run: Escape did nothing once focus had left the drawer (for example after fast-forward removed the button). Escape and focus trapping now listen on the document.

## Round 3: 8.5 / 10 (not claiming 9)
Why not 9: the detail drawer header leaves a band of empty space beside the dial when a dispute has few facts, and the arc on a nearly spent window is still a small shape. Everything else holds: one spacing scale (4, 8, 12, 16, 24, 32, 48), a seven-step type scale in rem, hover, focus, active and disabled states on every control, no horizontal scroll from 360 to 1920 in either theme, the countdown is the only bold element.

## Round 4: deletion pass, 9 / 10
Shots in `shots/round4` (rounds 1 to 3 kept). The page now answers one question: what needs me, and what happens if I ignore it.

Deleted:
- The "Next on the clock" card row (it repeated table rows).
- The five quick-action cards and the separate simulate box. One slim "Demo controls" row replaces both: template picker, Deliver webhook, +1h/+6h/+24h with the guard toggle, Run guard now, Reset demo.
- From the attention panel: the request path, the state chip, the provenance line, the evidence chips, the at-stake stat (the amount was already in the sentence twice) and the five-line package checklist. It is now one evidence sentence and one line on what the guard does.
- From the table: Filed by, per-row source lines, due-local lines (due time is a hover title). Columns are Dispute (item and buyer), Time left, Evidence, Amount, State. Closed disputes sit under a collapsed Closed group.
- Sidebar footer stat blocks, the "Simulate a dispute" button, and the header PayPal status chip (it lives under "What is real?").
- The honesty banner is one sentence plus a "What is real?" disclosure holding the full provenance table.
- Detail: the evidence checklist, evidence items, request, request id, history and raw trace moved behind disclosures. "How it decided" collects classification, the records pulled in order (grouped by turn), the score with its checklist, the stated reason, and the full trace.
- Evidence page: three headings above single items, the repeated mechanism sentence. Compare page: the lede that repeated the table, the request body (now a disclosure), the filed-path and goods lines that repeated each other.

Why 9 and not 10: the detail drawer still shows the full buyer message above the draft, and the dial arc on a nearly spent window is a small shape by design. Hierarchy, spacing, alignment at 360 to 1920, both themes and every control state hold.

## Click-through (scripts/clickthrough.mjs, run against the dev API; all pass)
- [x] Sidebar: All disputes
- [x] Sidebar: The evidence
- [x] Sidebar: Surrender vs defend
- [x] Sidebar: Home
- [x] Compare: dispute select changes preview
- [x] Compare: Open the full package
- [x] Theme toggle switches and persists
- [x] Template radio selects second option
- [x] Deliver webhook creates a dispute and shows the result card
- [x] Flow card: Open dispute button opens drawer
- [x] Drawer: Escape closes
- [x] Flow card: Dismiss
- [x] Advance 1 hour(s)
- [x] Advance 6 hour(s)
- [x] Advance 24 hour(s)
- [x] Guard toggle flips label
- [x] Run guard now shows a message
- [x] Toast dismiss button
- [x] Reset demo clears the demo clock chip
- [x] Closed group expands and a closed row opens
- [x] What is real? disclosure expands and shows PayPal status
- [x] How it decided disclosure opens and lists the score
- [x] Table row link opens drawer
- [x] Review and file opens drawer
- [x] Drawer Close button
- [x] File response: dialog opens, focus on Cancel, Tab stays inside
- [x] Dialog: Escape closes the dialog only
- [x] Dialog: Cancel button
- [x] Edit the draft, confirm File response -> Filed
- [x] Filed state persists across reload
- [x] Fast-forward PayPal review (simulated)
- [x] Accept claim: dialog states refund and cannot be undone, confirm -> Accepted
- [x] Idempotent re-file shows "already filed" (API returns idempotent_replay (UI wording checked in code))
- [x] Evidence page figures present
- [x] Failed webhook shows recovery (simulated 504)
- [x] 409 on action shows "changed" message
- [x] NEW state renders (mocked): working note, no crash
- [x] Mobile: Menu opens the sidebar and navigates
- [x] Mobile: no horizontal scroll
- [x] Keyboard: Tab reaches controls with a visible focus ring
- [x] No uncaught page errors or native dialogs

## Not covered
- The queued (HTTP 202) agent path was exercised with a mocked NEW dispute only; the local dev server completes inline.
- The live-model trace grouped by turn renders from the contract; the dev server (Bedrock off) has no turn data to show.
- 200% text zoom was checked by layout at 640 and 360 wide, not with a browser zoom.
