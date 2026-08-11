# NestJS Backend Rules

- Keep controllers thin: validate transport input, call an application service, and return the shared response envelope.
- Keep domain decisions in application services and persistence details in repositories.
- Use schemas and protocol identifiers from `@sceneboard/board-schema` at transport boundaries instead of maintaining local wire-contract copies.
- Use the existing application error hierarchy and central HTTP filter for expected failures.
- Preserve board mutation idempotency, revision preconditions, transactional durability, and event ordering when changing write paths.
- Treat authentication, pairing, grants, HITL, artifact isolation, migrations, Redis fan-out, and retention as security- or data-sensitive boundaries.
- Database changes require an ordered migration, restart/adoption consideration, postcondition coverage, repository tests, and isolated integration QA.
- Keep boot and recovery operations fail-closed: do not report readiness before environment, persistence, migration, and security preconditions pass.
- Keep long-running or retryable operations bounded and make restart behavior explicit; do not rely on process memory for durable state.
- Do not log credentials, cookies, authorization headers, pairing proofs, or raw sensitive payloads.
- Add focused controller, service, repository, and cross-boundary contract coverage at the layer where behavior is owned.
