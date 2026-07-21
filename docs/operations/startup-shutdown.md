# SceneBoard certification startup and shutdown

This runbook is for isolated, non-production certification only. It does not authorize deployment or a shared database/Redis/browser environment.

## Current gate

Do not start a listener while any of these are unresolved: dirty or unattested source, contract manifest drift, dependency mismatch, forbidden `npx` configuration, unavailable isolated MySQL/Redis, or an unapproved browser/live adapter. The current certification command reports `BLOCKED` rather than skipping these gates.

## Startup order

1. Stop Next, Nest, the artifact runtime, and MCP children owned by the proposed attempt.
2. Require an exact clean Git source attestation and unchanged watched inputs.
3. Run `npm run verify:contracts`, `npm run verify:dependencies -- --profile=static`, and `npm run verify:config`.
4. Certify each exact-owned MySQL scenario. Select a separate release-runtime schema only after its correlated `FULL_OFFLINE` result passes, then require `BOUNDED_RESTART`.
5. Start the supervised Nest process on `127.0.0.1:3411` and wait for owner-defined readiness.
6. Start Next on `127.0.0.1:3410` only after protected API probes pass.
7. Start the artifact runtime on `127.0.0.2:3412` only after topology/header/credentialless evidence passes.
8. Verify D7/D8 live provider composition, then publish MCP over stdio in exact cuts 3, 15, and 21. Missing tools are absent, never stubs.

The attempt envelope records observed state; changing it never enables a process, route, provider, writer, or tool.

## Shutdown order

1. Stop new certification cases and remove MCP protected/final publication through the D6 owner seam.
2. Stop artifact/HITL admission and drain bounded active work.
3. Close browser contexts and service workers, then stop the artifact runtime and Next.
4. Stop SSE admission/dispatcher claims, drain streams, then stop Nest.
5. Close database/Redis connections and verify the exact attempt-owned prefix and schemas are clean.
6. Finalize cleanup evidence. Any remaining child, listener, connection, context, service worker, prefix, schema, or fixture root is `FAIL`.

Never use broad process kills, wildcard schema deletion, `FLUSHDB`, `FLUSHALL`, or cleanup outside the exact owner token.
