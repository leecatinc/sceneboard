# SceneBoard command contract and test surface

Prefer tools returned by MCP discovery. Before authentication exactly the three connection/pairing tools are visible; terminal authenticated discovery contains exactly the 21 tools below and no aliases. If SceneBoard descriptors are absent, the bundled adapter accepts the same protected operation names and exact inputs over JSON stdin. Pairing is the sole transport-shaped exception: the fallback keeps the proof private inside one `pair` process instead of exposing separate request/status invocations.

## Shared rules

- Every board-scoped call requires an explicit `boardId`. `board_list`, `board_connection_status` with a null target, and `board_create` are the only pre-board operations. After creation, use the exact returned `boardId`.
- Every mutation requires `expectedRevisionId` and an explicit 16-128 character `idempotencyKey`, except board create/archive use their frozen lifecycle shapes. Identical semantic retry reuses the entire request; a conscious rebase uses a new key.
- Mutation outputs are exact D1 `MutationResultV1` envelopes. Reads are exact `BoardOperationResultV1` envelopes. The MCP tool wrapper or fallback JSON wrapper `requestId` equals the nested result request ID. MCP non-history metadata is `null`; the API HTTP/fallback envelope uses `{history:null}`, while local patch wrapper metadata records the scene transform.
- There is no `historyMode`, `commitLabel`, clear message, implicit board selection, or auto-generated mutation key.

## Exact inputs and result branches

| Tool | Exact important input | Exact success |
|---|---|---|
| `board_connection_status` | `{boardId:null\|<id>}` | Redacted connection state; null authenticates without selecting a board. |
| `board_pair_request` | `{code,clientName,requestedScopes,requestedLifecyclePermissions}` | Secret-free claimed pairing projection. New human codes use the `SB-` prefix before the two code groups; an already-issued legacy unprefixed body remains accepted until expiry. |
| `board_pair_status` | `{pairingId,waitTimeoutMs}` | Secret-free pending/approved/denied/cancelled/expired/redeemed projection. |
| `board_list` | `{cursor,limit,includeArchived}` | `board.list` |
| `board_get` | `{boardId}` | `board.get` |
| `board_create` | `{title,idempotencyKey}` | `board.create` |
| `board_archive` | `{boardId,confirm:true,idempotencyKey}` | `board.archive` |
| `board_capabilities_get` | `{boardId}` | `capabilities.get` |
| `board_scene_get` | `{boardId,revisionId:null\|<id>}` | Live `board.get`, or historical `history.get` with aligned history metadata. |
| `board_scene_replace` | `{boardId,expectedRevisionId,idempotencyKey,scene}` | `scene.replace` |
| `board_scene_patch` | `{boardId,expectedRevisionId,idempotencyKey,operations}` | One `scene.replace`; metadata includes `transformedFromRevisionId`. |
| `board_scene_clear` | `{boardId,expectedRevisionId,idempotencyKey}` | `scene.clear` |
| `board_artifact_get` | `{boardId,artifactId,versionId}` | `artifact.get` manifest/runtime for the exact immutable pair. |
| `board_artifact_put` | `{boardId,expectedRevisionId,idempotencyKey,artifactId:null\|<id>,html,css:null\|string,javascript:null\|string,requestedCapabilities}` | `artifact.publish` |
| `board_artifact_stop` | `{boardId,expectedRevisionId,idempotencyKey,artifactId,versionId,reason}` | `artifact.stop`; does not remove scene placement. |
| `board_history_list` | `{boardId,cursor,limit}` | `history.list` newest first with aligned metadata. |
| `board_history_get` | `{boardId,revisionId}` | `history.get` immutable scene/current-cut summaries with navigation metadata. |
| `board_history_restore` | `{boardId,revisionId,expectedRevisionId,confirm:true,idempotencyKey}` | `scene.restore` copy-forward. |
| `board_interaction_request` | `{boardId,expectedRevisionId,idempotencyKey,hitlRequestId,definition}` | `hitl.request` in `open`. |
| `board_interaction_status` | `{boardId,hitlRequestId,wait:null\|{afterStateUpdatedAt,timeoutMs}}` | `hitl.read` with exact `changed` and interaction state. |
| `board_interaction_respond` | `{boardId,expectedRevisionId,idempotencyKey,hitlRequestId,response}` | `hitl.respond` in `answered`. |

`definition.kind` is exactly `info|choice|form|confirmation`; `response.kind` must match. Do not request authentication secrets through HITL. Bounded-wait status is the default response delivery path described in the skill.

Every successful open request is included in the current board snapshot. If the Scene has no matching `content.hitl` node, the browser presents it in the board-level decision tray. An explicit node may be added only after creation with the exact returned `hitlRequestId`; a waiting message is not a substitute for a real interaction.

Artifact capabilities are sorted unique values from `clipboard.write|download|fullscreen|network.fetch`. Capability request input never self-approves.

## Closed errors

Protected tools share `INVALID_PAYLOAD`, `PROTOCOL_VERSION_MISMATCH`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, and `INTERNAL_ERROR`; board-scoped tools add `BOARD_NOT_FOUND`. Mutations add `REVISION_CONFLICT` and `IDEMPOTENCY_KEY_REUSED` where applicable.

- Scene replace/patch: `UNKNOWN_NODE_TYPE`, `INVALID_LAYOUT`, `DUPLICATE_NODE_ID`, `LIMIT_EXCEEDED`, `PAYLOAD_TOO_LARGE`.
- Scene/history exact revision reads or restore: `REVISION_NOT_FOUND` where applicable.
- Archive: `BOARD_ALREADY_ARCHIVED`.
- Artifact get: `ARTIFACT_NOT_FOUND`; stop adds it to mutation errors.
- Artifact put: `LIMIT_EXCEEDED`, `PAYLOAD_TOO_LARGE`, and the only reachable `CAPABILITY_DENIED` branch.
- HITL request: `HITL_REQUEST_ID_CONFLICT`, `LIMIT_EXCEEDED`, `PAYLOAD_TOO_LARGE`.
- HITL status: `HITL_REQUEST_NOT_FOUND`.
- HITL respond: `HITL_REQUEST_NOT_FOUND`, `HITL_RESPONSE_CONFLICT`, `HITL_REQUEST_EXPIRED`, `PAYLOAD_TOO_LARGE`.

`CAPABILITY_DENIED` is invalid for every tool except `board_artifact_put`. MCP-local errors retain the `BOARD_MCP_*` namespace. The official fallback uses the closed `BOARD_API_*` local namespace for config, credential, profile, not-connected, transport, timeout, response-invalid, and internal failures while returning server D1 and pairing error codes unchanged.

On `REVISION_CONFLICT`, re-read and consciously reapply with a new key. On `IDEMPOTENCY_KEY_REUSED`, stop unless replaying the byte-identical semantic request. Do not translate these into legacy `BOARD_REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, or open-ended skill-only codes.
