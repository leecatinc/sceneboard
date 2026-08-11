# SceneBoard MCP Rules

- Keep MCP tool schemas, fallback API behavior, the Codex plugin, and the shipped SceneBoard skill aligned.
- Treat credential discovery, pairing, token storage, redaction, and transport retries as security boundaries.
- Parse every server response through the owning shared schema before returning a tool result. Do not weaken validation to hide adapter/server version skew.
- Keep direct and fallback transports behaviorally equivalent for tool names, request and result shapes, error codes, capability checks, and redaction.
- Enforce the resolved board and granted capability set for every operation; a fallback path must never broaden authorization.
- Preserve idempotency keys and revision preconditions on mutations, and keep read operations free of hidden writes.
- Keep stdout protocol-safe; send diagnostics through the established safe logger or stderr path.
- Keep tool results bounded and deterministic. Do not include credentials, local file paths, installation identity, or unrequested server payload fields.
- Update contract tests whenever a tool name, scope, request shape, result shape, parser, or fallback behavior changes.
- Keep the canonical skill under `/workspace/lc/leecat-board/skills/sceneboard/` and use the repository sync/check command for the plugin and private lc-skills deployment mirror. Never publish directly to `/workspace/.AI/skills`; the private lc-skills deploy workflow owns the shared runtime.
