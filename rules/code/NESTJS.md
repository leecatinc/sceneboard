# NestJS Backend Rules

- Keep controllers thin: validate transport input, call an application service, and return the shared response envelope.
- Keep domain decisions in application services and persistence details in repositories.
- Use the existing application error hierarchy and central HTTP filter for expected failures.
- Treat authentication, pairing, grants, HITL, artifact isolation, migrations, Redis fan-out, and retention as security- or data-sensitive boundaries.
- Database changes require explicit migration, rollback/adoption consideration, repository tests, and isolated integration QA.
- Do not log credentials, cookies, authorization headers, pairing proofs, or raw sensitive payloads.
