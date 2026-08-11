# Environment and Secret Rules

## Files and visibility

- Track only documented templates such as `.env.example`. Populated `.env` files, local MCP configuration, token caches, credentials, and private installation identities remain untracked.
- Add or rename an environment variable in the owning `.env.example`, parser, and focused tests in the same change.
- Treat every `NEXT_PUBLIC_` value as browser-visible configuration. Secrets and privileged service coordinates must use server-only names and stay behind the owning package's configuration boundary.
- Use visibly nonfunctional placeholders for secret examples. Do not copy production-shaped tokens, keys, account identifiers, or private origins into examples or fixtures.

## Validation and rollout

- Parse environment input once at the package boundary and pass typed configuration inward. Do not scatter permissive `process.env` fallbacks through domain code.
- Fail startup for missing required values, placeholders, malformed canonical origins, and values outside the documented enum or numeric range. Errors must identify the key without echoing its value.
- Parse booleans explicitly as `true` or `false`; do not rely on JavaScript truthiness.
- Keep security-sensitive and data-writing feature flags disabled by default until their rollout contract and rollback path are verified.
- Keep browser, API, and artifact-runtime origins explicit and canonical. Do not silently substitute one trust boundary for another.

## Evidence and operations

- Use environment variables or an approved secret store for credentials; deployment values do not belong in repository history.
- Redact secrets, cookies, authorization headers, tokens, pairing proofs, connection codes, email credentials, database URLs, and private key material from logs and test evidence.
- Tests that mutate `process.env` must restore the previous value and avoid leaking process-global configuration into other cases.
