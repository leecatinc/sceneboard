# SceneBoard platform and implementation contract

## Project roots

```text
sceneboard-fe/
sceneboard-be/
sceneboard-mcp/
packages/
  board-schema/
  board-ui/
  board-sdk/
  artifact-runtime/
```

## Authority and data services

- MySQL is authoritative for users, sessions, pairing records and both deadlines, grants/credentials, boards, revisions, idempotency, events/outbox, artifacts, interactions, audit, and retention evidence.
- Redis is ephemeral for rate limiting/calibration, SSE/browser presence, and explicitly frozen bounded wake/reconnect roles. Redis is never pairing-state/TTL, grant, credential, board-head, history, artifact, or HITL authority.
- Reuse approved environment/secret references only; never copy resolved database/cache credentials into plans, skills, examples, logs, or source. SceneBoard uses its own database and Redis prefix.

## Service boundary

```text
AI host -> local stdio MCP (preferred) -> Bearer Board API -> authorized MySQL transaction
AI host -> bundled skill adapter (MCP absent only) -> Bearer Board API -> authorized MySQL transaction
browser -> session API/SSE -> snapshot reconciliation + ordered live events
artifact iframe -> isolated runtime bridge/broker -> Board API policy
```

MCP and the skill adapter have no direct MySQL/Redis/Nest application import. Pairing claim is unauthenticated; status/redeem use the private PairingProof; protected board operations alone use Bearer. The browser and MCP use the shared SDK parser; the dependency-free adapter reconstructs closed public result/error projections, enforces resource correlation, body bounds and closed origins, and rejects secret-bearing response material while the API remains final request-schema and authorization authority.

## Shared ownership

- Internal workstream labels are: D1 protocol/schema; D2 authentication, pairing, grants, and database foundations; D3 board/revision/history persistence; D4 live events, Server-Sent Events, reconnect, and presence; D5 Next.js application and trusted rendering; D6 local MCP server and tools; D7 sandboxed artifact runtime; D8 human-in-the-loop interactions; D9 integration, security, quality assurance, and operations. These labels are internal shorthand, not a person-facing explanation; expand their meaning whenever they appear in content for a person.
- `packages/board-schema`: D1 wire scenes/nodes/layouts, operations/mutations, artifacts/HITL DTOs, limits, events, and stable errors.
- `packages/board-sdk/http`: bounded Bearer HTTP transport, strict response parsing, retry/deadline/cancellation.
- `packages/board-sdk/scene-transform`: the 11 local patch operations and one final scene validation.
- Nest D2/D3/D7/D8 modules: policy, persistence, application ports, and browser routes.
- MCP D6 exposes exactly 21 tool descriptors, including the connection/pairing projection; no aliases.

No lc-kits package is claimed as applied without concrete manifest/import/test evidence. Existing product contracts and code are authoritative over candidate scaffolds.
