# SceneBoard history contract

## Immutable revision history versus live delivery

- MySQL-authoritative revision history stores complete immutable scene snapshots, revision summaries, origin/source lineage, actor reference, and exact artifact references.
- SSE events are ordered live-delivery hints, not historical truth. Redis loss cannot rewrite history.
- `history.list` is newest first with an opaque cursor. `history.get` returns the exact revision scene plus the current-cut HITL/artifact runtime summaries frozen by D3 composition and aligned navigation metadata.

## Browser modes

- `live` renders the current server head and reconciles SSE.
- `history` pins one immutable revision locally while still tracking whether the live head advanced.
- `Previous`/`Next` navigate adjacent immutable revisions. `Latest` fetches/reconciles the current snapshot and resumes live mode.

Never apply incoming live events to the pinned historical scene.

## Restore, replace, and clear

Restore is copy-forward: `board_history_restore` requires exact `boardId`, source `revisionId`, observed live `expectedRevisionId`, `confirm:true`, and idempotency key; it creates a new head and preserves every old revision. Scene replace and clear also create restorable heads. V1 exposes no transient mode, custom commit label, clear message, client retention selector, history rewrite, or destructive restore.

## Storage authority

- MySQL owns users, boards, grants, revisions, snapshots, artifacts, interactions, pairing records/deadlines/outcomes, credentials, and audit evidence.
- Redis is limited to ephemeral rate-limit/calibration support, SSE/browser presence, bounded wake/reconnect helpers, and other explicitly frozen ephemeral roles. It does not own pairing state/TTL, board heads, snapshots, history, grants, credentials, artifact truth, or HITL truth.
- Retention must preserve referential integrity and never execute a different artifact version for an old revision.
