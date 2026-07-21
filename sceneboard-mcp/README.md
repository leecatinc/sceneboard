# SceneBoard MCP for Codex

SceneBoard MCP is the official public Codex marketplace for SceneBoard. The plugin bundles the SceneBoard skill and its local stdio MCP launcher so Codex can create, update, review, and present live boards after the user approves a one-time connection.

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

## Documentation

- [SceneBoard Codex installation guide](https://sceneboard.dev/integrations/codex)
- [SceneBoard](https://sceneboard.dev)
