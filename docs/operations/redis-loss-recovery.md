# SceneBoard Redis loss and SSE recovery

Redis is disposable coordination only; MySQL/outbox remains durable truth. Live drills require an isolated Redis instance or exact prefix `sceneboard:cert:<manifest-hash>:` under one attempt owner.

## Six drills

1. Cold Redis start.
2. Exact-prefix loss.
3. Redis process restart.
4. Bounded partition.
5. Stale, duplicated, and reordered hints.
6. Nest replacement during an active SSE stream.

Before and after each drill, compare sibling-owned safe MySQL fingerprints for board/head/revision/idempotency/outbox/artifact/HITL state. Store only safe IDs/statuses and payload digest/length—not rows, SQL, binds, or payload bodies.

Exercise snapshot-first admission, exact-next replay, duplicate/lower sequence, gap/resync, signed cursor and `Last-Event-ID`, backpressure, presence recovery, and authorization rechecks through D4's existing path. Pinned history must not move.

Full Redis flush is prohibited unless the instance is proven attempt-exclusive. Otherwise delete only enumerated exact-prefix keys. A guard mismatch stops before mutation; cleanup mismatch is `FAIL`.
