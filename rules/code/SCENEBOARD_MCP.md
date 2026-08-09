# SceneBoard MCP Rules

- Keep MCP tool schemas, fallback API behavior, the Codex plugin, and the shipped SceneBoard skill aligned.
- Treat credential discovery, pairing, token storage, redaction, and transport retries as security boundaries.
- Keep stdout protocol-safe; send diagnostics through the established safe logger or stderr path.
- Update contract tests whenever a tool name, scope, request shape, result shape, or fallback behavior changes.
- Keep the canonical skill under `/workspace/lc/leecat-board/skills/sceneboard/` and use the repository sync/check command for the plugin and private lc-skills deployment mirror. Never publish directly to `/workspace/.AI/skills`; the private lc-skills deploy workflow owns the shared runtime.
