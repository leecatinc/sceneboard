# SceneBoard fail-closed behavior

| Scenario | Required behavior |
|---|---|
| All SceneBoard descriptors absent | Use the bundled official API adapter from the open project root; do not call an alias/stub. |
| Some descriptors present | Treat MCP as initialized and fail closed for the missing capability; do not mix MCP and API operations in one workflow. |
| MCP call returned any error | Preserve the MCP result. Never switch to API to bypass auth, permission, validation, revision, rate-limit, timeout, or backend policy. |
| Not paired/configured | Use explicit-null connection diagnostics and pairing. Never request a long-lived token in chat. |
| Multiple/unknown boards | Call `board_list`; ask if candidates remain ambiguous. Never infer first/active/sole. |
| Transport/timeout | Return the exact transport-local MCP or API code; retry only within the bounded policy. |
| Browser offline/unknown | Persistence may succeed, but do not equate it with visible rendering. |
| `REVISION_CONFLICT` | Re-read and consciously reapply with a new key; no auto-rebase or blind retry. |
| `IDEMPOTENCY_KEY_REUSED` | Stop unless replaying the exact same semantic request bytes. |
| Unsupported node | Use a supported node or approved artifact; never invent a node tag. |
| Artifact denied/rejected | Report the exact safe `CAPABILITY_DENIED`, validation, limit, or payload class; never echo secrets/unsafe source. |
| Artifact published but host not active | Report publication and browser runtime topology separately; require a distinct reachable HTTPS runtime for an HTTPS parent and never claim it rendered. |
| Artifact stopped/pruned | Show the exact safe placeholder/metadata; never substitute another version. |
| HITL wait timeout | Reissue bounded wait with the same cursor and jitter when still needed; never fabricate a response. |
| HITL conflict/expiry | Yield to authoritative `HITL_RESPONSE_CONFLICT`/`HITL_REQUEST_EXPIRED`/terminal read. |
| Unknown failure | Surface the transport-local internal code with safe incident/request correlation only; no stack/header/config/source/credential. |

Pairing errors retain their separate closed codes. `CAPABILITY_DENIED` is not a generic authorization fallback and is valid only for artifact put. Principles: explicit scope, immutable history, bounded retry, mutation idempotency, fail closed, and never fabricate visible output.
