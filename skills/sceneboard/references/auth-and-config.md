# SceneBoard authentication, pairing, and config

## Authority

- Hosted v1 uses a signed-in owner. Board access is principal/grant scoped; MCP arguments never accept `userId`, raw credentials, or actor context.
- D2/MySQL alone owns pairing records, decision/redeem deadlines, lazy expiry/sweeps, proof-authenticated outcomes, grants, and credential digests. Redis may support rate limiting/calibration but is not pairing-state or TTL authority.
- Long-lived grant tokens and the one pairing proof remain outside model-visible content, diagnostics, logs, docs, and committed config.

## Five-minute pairing flow

1. The signed-in owner creates a pairing request in the web app and receives one branded human code: the `SB-` SceneBoard prefix followed by two hyphen-separated six-symbol Crockford groups. New codes always include the prefix; the server temporarily accepts the legacy unprefixed body so already-issued codes can expire normally.
2. The code's decision deadline is five minutes; the code itself grants no board access.
3. The MCP client calls `board_pair_request`, or the MCP-absent adapter runs `pair`, with `code`, its client name, sorted requested scopes, and lifecycle permissions. Claim is unauthenticated.
4. One private proof owner calls client-status/redeem with `Authorization: PairingProof …`; the proof is never a DTO or tool result.
5. The owner approves or denies the exact scopes/client. Approval creates the separate redeem deadline.
6. Redemption yields a grant token to the private process. Before persistence, the authorized connection must match the redeemed principal, client, grant, installation fingerprint, scopes, lifecycle permissions, boards, lifetime, status, and shared timestamps; approved capabilities must remain within the requested set. Only then may the process atomically persist and reload it before reporting `redeemed`/`hasToken:true`.

The owner may approve no existing boards only when both `board.write` and lifecycle `board.create` are approved. This is a create-capable empty grant, not access to every board: existing boards remain unavailable, and a board created through that grant is atomically added to its board bindings. A SceneBoard skill pairing always requests the complete scope and lifecycle catalog so the approval screen exposes every supported workflow at connection time. The owner may reduce or deny that request, and the client must use only the final redeemed grant.

Claim response loss is an unknown outcome and is not automatically retried. Recover by owner cancel/wait then create a new code. If the server reports redeemed but the sink commit cannot be proven, use owner rotation/revoke/re-pair recovery; never guess or expose the token.

Exact grant scopes in catalog order are `board.read`, `board.write`, `board.history.read`, `board.hitl.request`, `board.hitl.respond`, `board.media.write`, `artifact.publish`, and `artifact.control`. Lifecycle permissions are `board.create` and `board.archive`.

## Codex plugin installation

The recommended distribution is the SceneBoard Codex plugin. It installs this skill and the MCP launcher together from the official public `leecatinc/sceneboard` marketplace repository. The setup page is `https://sceneboard.dev/integrations/codex`.

```bash
codex plugin marketplace add leecatinc/sceneboard
codex plugin add sceneboard@sceneboard
```

Start a new Codex thread after installing or updating a plugin. Plugin installation is not account authorization: create a one-time code on SceneBoard's AI connections page, claim it through `$sceneboard`, and approve only the required boards and capabilities.

## MCP config precedence

The plugin launcher resolves one SceneBoard stdio server in this order:

1. `<open-project-root>/.mcp.json` `mcpServers.sceneboard` — a SceneBoard development override specific to the currently opened project.
2. The effective Codex project/user MCP configuration, resolved by Codex from trusted project `.codex/config.toml` and user `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`).
3. The bundled production runtime with `BOARD_API_URL=https://sceneboard.dev` and secret-free `store://sceneboard` profile metadata.

An invalid selected SceneBoard entry fails closed. The launcher does not fall through to another server after a malformed project entry, disabled Codex entry, unsupported HTTP entry, or recursion. A project-root `.mcp.json` is a SceneBoard development override, not Codex's general durable configuration format.

## Project-root `.mcp.json` development override

Register a locally built SceneBoard server beside other project MCP servers. Keep the long-lived grant out of this file; pairing writes it to the private profile store.

```json
{
  "mcpServers": {
    "sceneboard": {
      "command": "node",
      "args": ["/absolute/path/to/sceneboard-mcp/dist/index.js"],
      "env": {
        "BOARD_API_URL": "https://sceneboard.dev",
        "BOARD_ACCESS_TOKEN_REF": "store://sceneboard",
        "BOARD_PROFILE": "sceneboard",
        "BOARD_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

Start a new Codex thread after changing MCP or plugin configuration; tool discovery for an already-running model session is not hot-reloaded. The environment fallback is secret-free and supports both writable `store://<profile>` pairing and the legacy read-only `env://SCENEBOARD_ACCESS_TOKEN` reference. `BOARD_ACCESS_TOKEN_REF` must equal `store://BOARD_PROFILE` in store mode.

## Explicit account API-key mode

Pairing remains the default and primary connection mode. Use account API-key mode only when the
owner intentionally wants asynchronous board management without a live pairing session. Set the
exact discriminator `BOARD_CREDENTIAL_MODE=api_key`; existing configurations without it remain
pairing configurations.

Never put an API-key literal in `.mcp.json`, command arguments, documentation, or logs. Reference an
environment value instead:

```json
{
  "mcpServers": {
    "sceneboard": {
      "command": "node",
      "args": ["/absolute/path/to/sceneboard-mcp/dist/index.js"],
      "env": {
        "BOARD_API_URL": "https://sceneboard.dev",
        "BOARD_CREDENTIAL_MODE": "api_key",
        "BOARD_ACCESS_TOKEN_REF": "env://SCENEBOARD_API_KEY",
        "BOARD_PROFILE": "sceneboard",
        "BOARD_TIMEOUT_MS": "30000"
      },
      "env_vars": ["SCENEBOARD_API_KEY"]
    }
  }
}
```

For an owner-only private file, use matching
`BOARD_ACCESS_TOKEN_REF=store://BOARD_PROFILE`, then provide the key through a non-echoing terminal
or stdin. The secret is never accepted on argv:

```bash
sceneboard-mcp api-key set --config=/absolute/path/to/api-key.board.json
sceneboard-mcp api-key remove --config=/absolute/path/to/api-key.board.json
```

The API-key file is `api-key.credential.json`, separate from the pairing `credential.json`, so the
two records can coexist. A `401` invalidates only this process's in-memory API-key snapshot; it does
not delete the private record. Explicit `set` and `remove` are the only storage mutations. Private
file API-key storage fails closed on Windows; use `env://SCENEBOARD_API_KEY` there.

API-key scopes are selected when the owner issues the key. Board CRUD and rename use the matching
board scopes; `board_export` additionally requires `export:read`. Pairing credentials and API-key
credentials remain separate, so switching to explicit API-key mode does not revoke or alter an
existing pairing connection.

The file form is also exact:

```json
{
  "version": 1,
  "baseUrl": "https://sceneboard.dev",
  "accessTokenRef": "env://SCENEBOARD_API_KEY",
  "authScheme": "bearer",
  "timeoutMs": 30000,
  "profile": "sceneboard",
  "credentialMode": "api_key"
}
```

`board_connection_status` identifies API-key mode with
`credentialMode:"api_key"` and returns only
`credentialMode,state,config,connection,lastErrorCode,retryable`. Pairing status payloads and the
pre-configuration `not_configured` payload remain unchanged.

## `.board.json` v1 compatibility

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:3411",
  "accessTokenRef": "env://SCENEBOARD_ACCESS_TOKEN",
  "authScheme": "bearer",
  "timeoutMs": 30000,
  "profile": "local"
}
```

The schema at `sceneboard-mcp/config/board.json.schema.json` is authoritative for file-based compatibility. Config discovery remains: explicit CLI path, `BOARD_CONFIG`, nearest `.board.json` walking upward, user config, then the exact non-file environment fallback used by `.mcp.json`. A selected invalid candidate fails closed without falling through.

Reject unknown/duplicate fields, invalid UTF-8/size, placeholders, credential-bearing URLs, conflicting env/store credentials, unsupported versions, unsafe symlinks/ownership/modes, and unavailable writable sinks. `env://` is read-only and cannot perform pairing. `store://` requires the verified Linux kernel-lease helper and private file store; unsupported/missing helpers fail closed. Remote MCP transport is future scope in v1.

Diagnostics expose only safe state such as token presence after proof, never token/proof/code/header/store paths.

## API fallback credential compatibility

The bundled fallback stores one private `store://<profile>` credential under the platform state directory. Linux retains the MCP-compatible owner-only `0700` directory and `0600` credential record. Windows stores the profile under `%LOCALAPPDATA%/leecat-board/credentials/<profile>` and writes only a Windows Data Protection API (DPAPI) `CurrentUser` ciphertext; the bearer token is never written to disk in plaintext. Windows decryption is therefore bound to the same signed-in operating-system user. The fallback never accepts a token on argv or stdin and never returns a token, proof, challenge, generation, or store path. Pair input arrives through stdin so the human code is not exposed in the process list; the proof exists only in the live process, its mutable seed bytes are overwritten on exit, and derived strings are dropped.

Fallback configuration resolution is intentionally narrow:

1. `<open-project-root>/.mcp.json` `mcpServers.sceneboard.env` with `BOARD_API_URL`, `BOARD_PROFILE`, `BOARD_TIMEOUT_MS`, and matching `BOARD_ACCESS_TOKEN_REF=store://<profile>`.
2. Secret-free `SCENEBOARD_API_URL`, `SCENEBOARD_PROFILE`, and `SCENEBOARD_TIMEOUT_MS` environment overrides.
3. `https://sceneboard.dev`, profile `sceneboard`, and 30 seconds.

Project fallback selection occurs only when at least one of the four `BOARD_*` fields is present; then all four exact fields are required and unknown fields fail closed. Otherwise all three `SCENEBOARD_*` overrides are considered before defaults. Only an exact HTTPS origin or exact loopback HTTP origin is accepted. API fallback pairing holds a conservative private `api-pairing.lock`; short-lived credential mutations use a separate private lock, atomic replacement, and generation-conditional quarantine/removal. Linux additionally enforces exact owner and `0700`/`0600` mode checks. Windows rejects symbolic-link endpoints and relies on DPAPI `CurrentUser` confidentiality instead of Unix mode bits or directory `fsync`. If DPAPI, `%LOCALAPPDATA%`, or the fixed system PowerShell host is unavailable, credential operations fail closed with `BOARD_API_CREDENTIAL_UNAVAILABLE`. Because fallback is supported only while MCP descriptors are absent, do not run MCP pairing and fallback pairing concurrently. A lock left after a killed process is never auto-broken: inspect and remove it out of band only after confirming no fallback process owns it.
