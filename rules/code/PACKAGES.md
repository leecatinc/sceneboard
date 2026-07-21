# Shared Package Rules

- `board-schema` owns wire schemas and stable protocol identifiers.
- `board-sdk` owns transport/client behavior and state reconciliation contracts.
- `artifact-runtime` owns isolated artifact execution and runtime policy.
- `board-ui` owns reusable rendering and interaction UI.
- Keep package exports intentional and minimal. Do not import another package's private paths.
- Protocol changes require compatibility fixtures and tests before consumers are updated.
- Avoid circular package dependencies and consumer-specific behavior in shared packages.
