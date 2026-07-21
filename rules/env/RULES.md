# Environment and Secret Rules

- Commit only documented examples such as `.env.example`; never commit a populated `.env`, credential file, local MCP config, token cache, or private installation identity.
- Use environment variables or an approved secret store for credentials.
- Example values must be visibly nonfunctional and must not resemble live credentials.
- Validate required runtime values at startup and fail with a stable, non-secret error.
- Redact secrets, cookies, authorization headers, tokens, pairing proofs, connection codes, email credentials, and database URLs from logs and test evidence.
