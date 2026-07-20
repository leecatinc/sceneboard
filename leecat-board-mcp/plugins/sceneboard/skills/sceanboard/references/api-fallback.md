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

### Windows PowerShell

Use the bundled launcher, which delegates to the same official Node adapter. Build the object with `ConvertTo-Json` and pipe it on stdin. Do not define `Invoke-SceneBoardApi`, call `Invoke-RestMethod`/`Invoke-WebRequest`/`curl`, or implement REST, credential decryption, retries, or response projection in PowerShell.

```powershell
$adapter = 'C:\absolute\path\to\sceanboard\scripts\sceneboard-api.ps1'
$inputObject = @{ boardId = $null } | ConvertTo-Json -Compress -Depth 64
$inputObject | & $adapter invoke board_connection_status
```

For `describe`, invoke `& $adapter describe` without stdin. For pairing, pipe the complete pairing object to `& $adapter pair` and keep that one process alive through redemption. Pairing codes and protected inputs must remain on stdin, never argv.

The API process wrapper adds one transport envelope around the protected command result. For example, after a successful `board_artifact_put`, read the immutable identifiers from `$.result.result.artifact.artifact.{artifactId,versionId}` in the wrapper output. MCP tool output uses its documented command result directly. Do not guess a shallower path or treat a missing projected field as permission to publish or place different content.

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
  "requestedScopes": ["board.read", "board.write", "board.history.read", "board.hitl.request", "board.hitl.respond", "artifact.publish", "artifact.control"],
  "requestedLifecyclePermissions": ["board.create", "board.archive"]
}
```

Scopes and lifecycle permissions must include the complete catalog in the exact order shown above and in [auth-and-config.md](auth-and-config.md). SceneBoard shows the complete request to the signed-in owner, who remains responsible for approving or reducing it; the adapter never treats a requested capability as approved before redemption proves the final grant. A zero-board approval without both `board.write` and `board.create` is invalid. The process validates every finite-state response and emits secret-free `claimed`, `status`, and final `redeemed` or `terminal` events. Keep it alive until the owner approves or the pairing reaches a terminal state. Claim response loss is never retried. On redeem response loss, the same proof owner checks status and performs at most the one contract-authorized retry; otherwise follow the returned owner recovery.

After redemption, the adapter verifies server authorization, writes the private credential, and reloads it before reporting success. A closed `BOARD_API_PAIRING_CREDENTIAL_UNRECOVERABLE` failure includes only a safe `phase` (`connection_request`, `authorization_validation`, `credential_write`, `credential_reload`, or `credential_reload_mismatch`) and, when applicable, an allowlisted Windows DPAPI reason. It never includes a token, filesystem path, command output, or raw exception. Revoke or rotate the created connection before retrying with a fresh code.

## Transport gate

1. If all SceneBoard descriptors are absent, select API for the workflow and keep using it.
2. If any SceneBoard descriptor is present, select MCP. A missing individual descriptor is unavailable; do not mix transports.
3. If an MCP operation returns an error, return that error. Do not invoke this adapter.
4. Browser verification remains separate from persistence. A successful API result does not prove a live tab rendered it.

## Ambiguous mutation recovery

An `ok:false` result, nonzero process exit, timeout, or invalid response is not a successful mutation response. Preserve its safe error code and incident identifier. Do not switch transports, retry a publication, invent a new artifact/version, or replace the intended artifact Scene with native fallback content.

Use the same official adapter to read the latest durable state once:

- For artifact placement, require the current Scene to contain the exact published `artifactId` and `versionId`.
- For a Scene replacement, require the current Scene to equal the intended canonical Scene.

If the exact target exists, report that persistence was confirmed by the read while the original mutation response remained invalid; continue only after obtaining any fresh head required by the next independent mutation. If it does not exist, stop as blocked with the original error. Never claim browser rendering from this recovery read.

The adapter has no external package dependency, follows complete project `.mcp.json` development overrides, defaults to `https://sceneboard.dev`, uses the selected private `store://<profile>` credential, applies one total deadline per operation, and emits closed connection/error/result projections with resource correlation and secret-material rejection. Linux protects the local record with owner-only filesystem permissions. Windows stores only a DPAPI `CurrentUser` ciphertext under `%LOCALAPPDATA%`, so another operating-system account cannot decrypt the bearer token. It rejects redirects and unsafe origins and never prints authorization material.
