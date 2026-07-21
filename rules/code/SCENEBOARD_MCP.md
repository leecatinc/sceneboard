# SceneBoard MCP Rules

- Keep MCP tool schemas, fallback API behavior, the Codex plugin, and the shipped SceneBoard skill aligned.
- Treat credential discovery, pairing, token storage, redaction, and transport retries as security boundaries.
- Keep stdout protocol-safe; send diagnostics through the established safe logger or stderr path.
- Update contract tests whenever a tool name, scope, request shape, result shape, or fallback behavior changes.
- Keep the canonical skill under `sceneboard-mcp/plugins/sceneboard/skills/sceneboard/` and use the repository sync/check command for any distributed copies.
