# Demo 06 — Revision Time Travel

PAIRING_CODE: `{{SB_CODE}}`

Read `demo/_COMMON.md` and follow it as mandatory operating policy. Then execute this runbook immediately.

## Goal

Create a compact sequence of visibly different revisions, then demonstrate that SceneBoard preserves and navigates the AI work without rewriting history.

## Connection and board

Request `board.read`, `board.write`, `board.history.read`, and `artifact.publish`, plus lifecycle `board.create`. Create:

`SceneBoard Demo — Every AI Change Preserved`

## Revision sequence

Create exactly four meaningful revisions. Do not create extra progress-only mutations between them.

### Revision 1 — brief

A native scene titled `Build a Launch Readiness Story` with three requirements:

- Make status understandable in five seconds.
- Show one material risk.
- Make the next decision explicit.

### Revision 2 — structured dashboard

A native dashboard with illustrative values:

- Product readiness: 92%.
- Reliability checks: 18 of 20 passed.
- Open risk: artifact rendering must be verified in a real browser.
- Decision: proceed to final rehearsal only after browser verification.

Mark all values as illustrative demo data.

### Revision 3 — animated launch room

Publish and place a 1200×675 artifact that transforms the same facts into a mission-control display. Animate the readiness ring, check sequence, risk beacon, and decision gate over 6–8 seconds. End on a stable complete frame.

### Revision 4 — decision recorded

Publish a final native scene or artifact that preserves all facts and adds:

`Decision recorded: browser verification passed; final rehearsal may begin.`

This is demo narrative, not a claim about the current production deployment.

## History verification and recording

Use `board_history_list` to verify all four intended revisions exist and remain immutable. Do not restore history.

If browser control is available:

1. Start on revision 4.
2. Select `Previous` to show revision 3 for four seconds.
3. Select `Previous` to show revision 2 for four seconds.
4. Select `Previous` to show revision 1 for four seconds.
5. Select `Latest` and hold revision 4.

Explain in one sentence:

`Previous and Latest change only the viewer's historical position; they do not rewrite the live board.`

End with:

`AI work evolves. SceneBoard keeps every meaningful version inspectable.`

