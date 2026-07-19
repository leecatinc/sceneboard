# SceneBoard MCP-absent API fallback

Use this path only when the current host exposes no SceneBoard `board_*` descriptors. Descriptor absence includes a transport that was not installed or did not initialize; an error from an exposed MCP tool is not absence. Never mix MCP and API calls to bypass a failed policy decision.

## Invocation

Resolve the absolute path of this installed skill, keep the shell working directory at the user's open project root, and execute with Node.js 22 or newer. Send exactly one JSON object on stdin. Do not place input JSON, pairing codes, credentials, or sources on argv.

```bash
node /absolute/path/to/sceanboard/scripts/sceneboard-api.mjs describe
printf '%s' '<exact tool input JSON>' | node /absolute/path/to/sceanboard/scripts/sceneboard-api.mjs invoke board_list
```

The second line illustrates the stream shape only. When executing, use the host's safe stdin facility rather than interpolating untrusted JSON into a shell command. The output is one JSON line for an invocation:

```json
{"ok":true,"transport":"api","operation":"board_list","requestId":"…","result":{},"metadata":{"history":null}}
```

Failures are secret-free and nonzero:

```json
{"ok":false,"transport":"api","operation":"board_list","error":{"code":"BOARD_API_NOT_CONNECTED","message":"…","retryable":false,"details":{"recovery":"run_pair"}}}
```

Use the exact protected operation names and inputs in [commands.md](commands.md). `board_scene_patch` reads the current head, rejects it if it differs from `expectedRevisionId`, applies the ordered 11-operation catalog locally, and submits one `scene.replace`; the server validates the complete scene and remains the final schema authority. Preserve the original revision and idempotency key so a concurrent change produces `REVISION_CONFLICT` instead of a blind rebase.

## Pairing

Pairing must stay in one process because the proof is memory-only:

```bash
node /absolute/path/to/sceanboard/scripts/sceneboard-api.mjs pair
```

Send this exact object on stdin:

```json
{
  "code": "<SCENEBOARD_PAIRING_CODE>",
  "clientName": "Codex SceneBoard fallback",
  "requestedScopes": ["board.read", "board.write"],
  "requestedLifecyclePermissions": ["board.create"]
}
```

Scopes and lifecycle permissions must follow the catalog order from [auth-and-config.md](auth-and-config.md). Request `board.create` when the user expects the connection to create its first board; a zero-board approval without both `board.write` and `board.create` is invalid. The process validates every finite-state response and emits secret-free `claimed`, `status`, and final `redeemed` or `terminal` events. Keep it alive until the owner approves or the pairing reaches a terminal state. Claim response loss is never retried. On redeem response loss, the same proof owner checks status and performs at most the one contract-authorized retry; otherwise follow the returned owner recovery.

## Transport gate

1. If all SceneBoard descriptors are absent, select API for the workflow and keep using it.
2. If any SceneBoard descriptor is present, select MCP. A missing individual descriptor is unavailable; do not mix transports.
3. If an MCP operation returns an error, return that error. Do not invoke this adapter.
4. Browser verification remains separate from persistence. A successful API result does not prove a live tab rendered it.

The adapter has no external package dependency, follows complete project `.mcp.json` development overrides, defaults to `https://sceneboard.dev`, uses the selected private `store://<profile>` credential, applies one total deadline per operation, and emits closed connection/error/result projections with resource correlation and secret-material rejection. It rejects redirects and unsafe origins and never prints authorization material.
