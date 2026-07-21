# SceneBoard Rules Router

This is the source of truth for work inside the SceneBoard monorepo.

## Loading order

1. Read `rules/CRITICAL.md`.
2. Starting at every target file, search upward for a nearer `rules/RULES.md`.
3. Load the nearest matching domain branch. A nearer rule wins conflicts with this tree.
4. For cross-package work, load the applicable branch for every affected package.

## Branches

| Situation                                                            | Load                  |
| -------------------------------------------------------------------- | --------------------- |
| Source changes, refactors, API/UI implementation                     | `rules/code/RULES.md` |
| Test design, regression work, browser/API QA                         | `rules/qa/RULES.md`   |
| Environment variables, credentials, runtime/deployment configuration | `rules/env/RULES.md`  |
| Staging, commits, repository initialization, pushes, history changes | `rules/git/RULES.md`  |

## Repository boundaries

- `sceneboard-mcp/` owns the MCP server, Codex plugin, SceneBoard skill, and fallback clients.
- `sceneboard-be/` owns the NestJS API and persistence boundary.
- `sceneboard-fe/` owns the Next.js web application.
- `packages/` owns reusable schemas, SDKs, runtime code, and UI packages.
- Do not duplicate an owned contract across packages. Import the owning package or add a deliberate public contract there.
