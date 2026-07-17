# SceneBoard authentication, pairing, and config

## Authority

- Hosted v1 uses a signed-in owner. Board access is principal/grant scoped; MCP arguments never accept `userId`, raw credentials, or actor context.
- D2/MySQL alone owns pairing records, decision/redeem deadlines, lazy expiry/sweeps, proof-authenticated outcomes, grants, and credential digests. Redis may support rate limiting/calibration but is not pairing-state or TTL authority.
- Long-lived grant tokens and the one pairing proof remain outside model-visible content, diagnostics, logs, docs, and committed config.

## Five-minute pairing flow

1. The signed-in owner creates a pairing request in the web app and receives one 12-symbol human code formatted as two six-symbol groups separated by a hyphen.
2. The code's decision deadline is five minutes; the code itself grants no board access.
3. The MCP client calls `board_pair_request`, or the MCP-absent adapter runs `pair`, with `code`, its client name, sorted requested scopes, and lifecycle permissions. Claim is unauthenticated.
4. One private proof owner calls client-status/redeem with `Authorization: PairingProof …`; the proof is never a DTO or tool result.
5. The owner approves or denies the exact scopes/client. Approval creates the separate redeem deadline.
6. Redemption yields a grant token to the private process. Before persistence, the authorized connection must match the redeemed principal, client, grant, installation fingerprint, scopes, lifecycle permissions, boards, lifetime, status, and shared timestamps; approved capabilities must remain within the requested set. Only then may the process atomically persist and reload it before reporting `redeemed`/`hasToken:true`.

Claim response loss is an unknown outcome and is not automatically retried. Recover by owner cancel/wait then create a new code. If the server reports redeemed but the sink commit cannot be proven, use owner rotation/revoke/re-pair recovery; never guess or expose the token.

Exact grant scopes in catalog order are `board.read`, `board.write`, `board.history.read`, `board.hitl.request`, `board.hitl.respond`, `artifact.publish`, and `artifact.control`. Lifecycle permissions are `board.create` and `board.archive`.

## Codex plugin installation

The recommended distribution is the SceneBoard Codex plugin. It installs this skill and the MCP launcher together from the official `leecatinc/leecat-board-mcp` marketplace repository. The setup page is `https://sceneboard.dev/integrations/codex`.

```bash
codex plugin marketplace add leecatinc/leecat-board-mcp
codex plugin add sceneboard@sceneboard
```

Start a new Codex thread after installing or updating a plugin. Plugin installation is not account authorization: create a one-time code on SceneBoard's AI connections page, claim it through `$sceanboard`, and approve only the required boards and capabilities.

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
      "args": ["/absolute/path/to/leecat-board-mcp/dist/index.js"],
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

Start a new Codex thread after changing MCP or plugin configuration; tool discovery for an already-running model session is not hot-reloaded. The environment fallback is secret-free and supports both writable `store://<profile>` pairing and the legacy read-only `env://LEECAT_BOARD_ACCESS_TOKEN` reference. `BOARD_ACCESS_TOKEN_REF` must equal `store://BOARD_PROFILE` in store mode.

## `.board.json` v1 compatibility

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:3411",
  "accessTokenRef": "env://LEECAT_BOARD_ACCESS_TOKEN",
  "authScheme": "bearer",
  "timeoutMs": 30000,
  "profile": "local"
}
```

The schema at `leecat-board-mcp/config/board.json.schema.json` is authoritative for file-based compatibility. Config discovery remains: explicit CLI path, `BOARD_CONFIG`, nearest `.board.json` walking upward, user config, then the exact non-file environment fallback used by `.mcp.json`. A selected invalid candidate fails closed without falling through.

Reject unknown/duplicate fields, invalid UTF-8/size, placeholders, credential-bearing URLs, conflicting env/store credentials, unsupported versions, unsafe symlinks/ownership/modes, and unavailable writable sinks. `env://` is read-only and cannot perform pairing. `store://` requires the verified Linux kernel-lease helper and private file store; unsupported/missing helpers fail closed. Remote MCP transport is future scope in v1.

Diagnostics expose only safe state such as token presence after proof, never token/proof/code/header/store paths.

## API fallback credential compatibility

The bundled fallback reads and writes the same private profile record format as `store://<profile>` under the platform state directory. It never accepts a token on argv or stdin and never returns a token, proof, challenge, generation, or store path. Pair input arrives through stdin so the human code is not exposed in the process list; the proof exists only in the live process, its mutable seed bytes are overwritten on exit, and derived strings are dropped.

Fallback configuration resolution is intentionally narrow:

1. `<open-project-root>/.mcp.json` `mcpServers.sceneboard.env` with `BOARD_API_URL`, `BOARD_PROFILE`, `BOARD_TIMEOUT_MS`, and matching `BOARD_ACCESS_TOKEN_REF=store://<profile>`.
2. Secret-free `SCENEBOARD_API_URL`, `SCENEBOARD_PROFILE`, and `SCENEBOARD_TIMEOUT_MS` environment overrides.
3. `https://sceneboard.dev`, profile `sceneboard`, and 30 seconds.

Project fallback selection occurs only when at least one of the four `BOARD_*` fields is present; then all four exact fields are required and unknown fields fail closed. Otherwise all three `SCENEBOARD_*` overrides are considered before defaults. Only an exact HTTPS origin or exact loopback HTTP origin is accepted. API fallback pairing holds a conservative private `api-pairing.lock`; short-lived credential mutations use a separate private lock, exact `0700` directory checks, atomic replacement, and generation-conditional quarantine/removal. Because fallback is supported only while MCP descriptors are absent, do not run MCP pairing and fallback pairing concurrently. A lock left after a killed process is never auto-broken: inspect and remove it out of band only after confirming no fallback process owns it.
