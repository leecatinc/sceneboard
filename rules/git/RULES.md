# Git Rules

Use for staging, commits, commit messages, and push preparation.

## Staging Filters

- Exclude files whose only difference is CRLF/LF line endings.
- To identify real content changes, inspect `git diff --ignore-cr-at-eol`; do not rely on `--name-only` with that flag.
- Exclude unrelated tests, temporary files, backups, environment files, OS/editor metadata, and generated artifacts unless the user explicitly asked to include them.
- Stage only files relevant to the current request.

## Commit Messages

- Write commit messages in Korean.
- Do not include AI agent metadata such as `Co-Authored-By`.
- Describe the actual user-visible or code-level change.

## Before Commit

- If `plan/backlog/open.md` exists, check only relevant high-priority (`H`) backlog items before committing.
- If a relevant high-priority backlog item exists, briefly ask whether to include, keep, or exclude it.
- If there are only medium/low items, proceed without extra noise.

## Safety

- Do not run destructive git commands such as `git reset --hard`, `git checkout --`, `git restore`, or `git clean -f` without explicit user confirmation.
