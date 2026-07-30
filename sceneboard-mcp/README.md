# SceneBoard MCP for Codex

SceneBoard MCP is the official public Codex marketplace for SceneBoard. The plugin bundles the SceneBoard skill and its local stdio MCP launcher so Codex can create, update, review, and present live boards after the user approves a one-time connection. Pairing remains the primary workflow.

## Install

```bash
codex plugin marketplace add leecatinc/sceneboard
codex plugin add sceneboard@sceneboard
```

Start a new Codex thread after installation. Then create a one-time connection code at [sceneboard.dev](https://sceneboard.dev), send the `SB-...` code to `$sceneboard`, and approve the matching request in SceneBoard.

## Update

```bash
codex plugin marketplace upgrade sceneboard
codex plugin add sceneboard@sceneboard
```

Start a new Codex thread after updating so the refreshed skill and MCP tools are loaded.

## Configuration precedence

The bundled launcher resolves SceneBoard in this order:

1. `<project>/.mcp.json` for an explicit development override.
2. Trusted Codex project or user MCP configuration.
3. The production default at `https://sceneboard.dev`.

The launcher fails closed when the selected configuration is invalid. Credentials are stored outside the repository and are never committed to the plugin.

## Optional account API-key mode

Owners may explicitly use an account API key for asynchronous board CRUD and export when a live
pairing session is inconvenient. This mode complements pairing; it does not remove or replace it.
Issue and revoke keys in SceneBoard account settings.

Never place the raw key in `.mcp.json`, command arguments, documentation, or logs. Reference an
environment variable:

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

API-key mode exposes only owner board/scene/document/page/history operations allowed by the issued
scopes. `board_export` requires `export:read` and an explicit retained `revisionId`. It publishes a
new PDF or PPTX only to an absolute output path that does not already exist. Secure local
publication is supported only on verified Linux x64 glibc builds; unsupported targets fail before
network or filesystem publication.

## Documentation

- [SceneBoard Codex installation guide](https://sceneboard.dev/integrations/codex)
- [SceneBoard](https://sceneboard.dev)
