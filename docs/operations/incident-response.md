# SceneBoard certification incident response

Certification incidents retain the immutable first safe failure, stop the affected owner surface, and never patch a sibling contract from D9.

| Failure cluster                             | Owner | Immediate action                                     |
| ------------------------------------------- | ----- | ---------------------------------------------------- |
| Schema/catalog/canonical fixture            | D1    | Stop contract certification and quarantine evidence. |
| Identity/session/pairing/authz/audit/runner | D2    | Block protected surfaces and database exposure.      |
| Board/revision/idempotency/outbox           | D3    | Keep Nest writer/listener gate closed.               |
| SSE/cursor/presence/Redis recovery          | D4    | Stop SSE admission and live-delivery phase.          |
| Renderer/routes/history/accessibility       | D5    | Stop browser/manual phase.                           |
| MCP config/stdio/tools/errors/skill         | D6    | Keep final descriptors unpublished or stop MCP.      |
| Artifact persistence/runtime/sandbox        | D7    | Stop runtime execution and retain trusted fallback.  |
| HITL persistence/state/UI/race              | D8    | Stop interaction exposure.                           |
| Orchestration/evidence/runbook              | D9    | Fix only D9 and start a new attempt.                 |

Secret-canary matches, cross-board disclosure, a second terminal HITL transition, artifact-origin cookie transport, output ownership violations, and cleanup failures are `FAIL`. Missing prerequisites, forbidden runner/config, or unavailable isolated infrastructure are `BLOCKED`. Neither becomes `SKIP`.

Evidence must contain only case/owner/safe code or state, bounded counters, hashes, cleanup result, and incident ID. Never include credentials, headers, raw config, SQL/binds, artifact source, HITL bodies, URLs with sensitive queries, screenshots, traces, or stdout unless a separately approved sanitization rule proves them safe.
