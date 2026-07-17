# Workspace Rules

This file is the workspace-local rule router. Start here when a task asks to use `lc-rules`.

## Loading Rules

1. Load `rules/CRITICAL.md` first.
2. Load only the narrow rule branch needed for the task.
3. If multiple branches apply, load each relevant branch.
4. If a branch instructs loading another skill, load that skill before editing.
5. If a needed branch does not exist, follow local codebase conventions and consider adding a focused rule file.

## Branches

| Situation | Load |
|---|---|
| Workspace-wide critical safety rules | `rules/CRITICAL.md` |
| Source code changes, refactors, API/UI implementation | `rules/code/RULES.md` |
| Test planning, QA scenario work, manual/browser/API QA | `rules/qa/RULES.md` |
| Environment variables, config files, secrets, deployment/runtime settings | `rules/env/RULES.md` |
| Git staging, commits, commit messages, push preparation | `rules/git/RULES.md` |

## Removed Legacy Paths

The source of truth is this `rules/` tree.

Do not load or recreate legacy rule files such as `.AI/CODE_RULES.md`, `.AI/rules/*`, `CODE_RULES.md`, `QA_RULES.md`, or `CRITICAL_RULES.md`. If an old prompt or historical artifact mentions those paths, route through `rules/RULES.md` instead.
