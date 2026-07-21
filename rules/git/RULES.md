# Git Rules

## Commit language and identity

- Write commit messages in English using Conventional Commits: `<type>(optional-scope): <imperative summary>`.
- Use the repository-local author name `LeeCat` and the owner-approved repository-local email configured in `.git/config`.
- Do not commit the author email into source files or shared configuration.
- Do not include AI agent metadata or `Co-Authored-By` trailers.

## Commit boundaries

- Keep formatting-only, mechanical rename, test-only, refactor, behavior, and migration changes separate when practical.
- Stage only files belonging to the current change. Do not use catch-all staging without reviewing every path.
- Exclude populated environment files, local MCP files, credentials, recordings, screenshots with private data, temporary output, build artifacts, and editor/OS metadata.

## Required pre-commit checks

1. Read `rules/CRITICAL.md` and `rules/env/RULES.md`.
2. Inspect `git status --short`, `git diff --cached --name-status`, and the complete `git diff --cached`.
3. Run `git diff --cached --check`.
4. Run the repository secret/config audit and the closest tests and typechecks required by `rules/qa/RULES.md`.
5. Block the commit until every suspicious value is removed or proven to be an intentionally safe fixture.

## History safety

- Do not delete `.git`, create an orphan replacement history, delete remote refs, or force-push without explicit approval for that exact operation.
- Before an approved history rewrite, create and verify a recovery bundle or mirror outside the repository, enumerate branches and tags, confirm remote protection settings, and define a rollback point.
- A force push changes branch-visible history but does not guarantee removal from clones, forks, pull request refs, caches, or provider retention.
