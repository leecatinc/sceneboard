# Critical Rules

- Never expose or commit credentials, tokens, passwords, private keys, local MCP configuration, production data, or unnecessary personal information.
- Before every commit, inspect the complete staged diff and run the secret/config audit required by `rules/git/RULES.md`.
- Never delete a `.git` directory, rewrite published history, force-push, replace a remote repository, or remove persistent data without explicit user approval and a verified recovery copy.
- Write engineering artifacts in English. This includes source comments, identifiers, documentation, commit messages, pull requests, issue text, logs, and developer-facing metadata. User-facing localization catalogs and localization fixtures are exempt.
- Do not add AI authorship claims, generated-by banners, agent metadata, or `Co-Authored-By` trailers.
