# Code Rules Router

Use this file for source code changes. It also contains the headless system prompt block used by tools that inject code rules automatically (the marker block stays in THIS file — external injectors expect it here).

## Rule Files (by consumption time)

| When | Load |
|---|---|
| Planning — detailed planning (planning MD authoring) + plan review: folder layout, layer boundaries, shared-util ownership, file split, naming, API design contract | `rules/code/STRUCTURE.md` |
| Implementation — implementation/optimization/test work before touching source: naming semantics, error handling contract, import order, logging, tests, dependency policy | `rules/code/CONVENTIONS.md` |

## Framework Branches

| Situation | Load |
|---|---|
| Koa/Node backend, API routes, backend services, database access | `rules/code/KOA.md` |
| React/Vite/frontend, TSX components, client state, UI behavior, CSS | `rules/code/REACT.md` |
| React Native, Expo, mobile app state/storage/sync, device UI | `rules/code/REACT_NATIVE.md` |

If a change spans backend and frontend, load each relevant branch.

## Project Branches

- If `rules/code/PROJECT.md` exists, load it after the relevant framework branch.
- If a subproject-specific rule file exists, load it when working under that subproject. Example: `rules/code/DOITQA_KOA.md`.

## How To Decide

- Inspect file paths, package manifests, imports, and nearby code.
- Prefer the project's existing patterns over adding new frameworks or abstractions.
- If the stack is not listed above, follow local conventions and add a new narrow branch only when repeated guidance would be useful.

<!-- HEADLESS_SYSTEM_PROMPT_START v2 -->

# Code Rules

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

## Think Before Coding

- State assumptions explicitly when they affect implementation.
- If multiple interpretations exist, surface the tradeoff before committing to one.
- If something is unclear enough to change the outcome, ask before editing.

## Simplicity First

- Implement the minimum code that solves the requested behavior.
- Avoid speculative features, one-off abstractions, and unnecessary configurability.
- If a smaller local change would solve the problem, prefer it.

## Surgical Changes

- Touch only files needed for the request.
- Preserve unrelated user changes and existing style.
- Do not refactor adjacent code unless it is required for the task.
- Remove only imports, variables, or helpers made unused by your own changes.

## Goal-Driven Execution

- Turn work into verifiable goals before editing.
- Add or update tests in proportion to risk and blast radius.
- Verify with the closest relevant check before finishing when practical.

## Common Local Rules

- Code comments should be written in Korean when adding comments.
- Preserve existing indentation, quotes, semicolons, and line-break style unless the task requires otherwise.
- Before coding, separate obvious objects, functions, or components when it keeps the implementation simpler.
- Keep files around 500-800 lines when practical. Split files above 1200 lines unless there is a strong local reason not to.
- Do not run build or server restart commands such as `npm run build` or `pm2 restart` unless the user explicitly asks.
- Do not run rollback commands such as `git checkout`, `git restore`, or `git reset --hard` without explicit user confirmation.
- In offline environments, do not use `npx`; use local binaries, package scripts, or already-installed tooling.

<!-- HEADLESS_SYSTEM_PROMPT_END -->
