# Shared Package Rules

- `board-schema` owns wire schemas and stable protocol identifiers.
- `board-sdk` owns transport/client behavior and state reconciliation contracts.
- `artifact-runtime` owns isolated artifact execution and runtime policy.
- `board-ui` owns reusable rendering and interaction UI.
- Keep package exports intentional and minimal. Import declared public entry points; never reach into another package's private paths.
- Preserve dependency direction: schemas stay independent, transport code depends on schemas, and application packages consume shared contracts rather than reversing ownership.
- Put protocol changes in `board-schema` first, with compatibility fixtures and parser tests, before updating SDK, backend, frontend, or MCP consumers.
- Keep Node-only code behind server entry points so browser-facing exports remain platform-safe.
- Keep shared transformations deterministic and free of application-specific state, credentials, filesystem assumptions, and hidden network access.
- Avoid circular dependencies and consumer-specific branches in shared packages. If only one application needs behavior, keep it with that application until a reusable contract exists.
- Run the changed package's tests and typecheck plus tests for every consumer whose public contract is affected.
