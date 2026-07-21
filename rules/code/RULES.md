# Code Rules

Load this file before planning or changing source code.

## Language and readability

- Write comments, docstrings, identifiers, error codes, logs, test descriptions, and developer-facing text in English.
- Localization resources and tests may contain the language they intentionally verify.
- Prefer explicit types, schemas, invariants, and dependency boundaries over implicit behavior.
- Comments explain why a constraint exists; do not narrate clear code.
- Use descriptive names instead of project-local shorthand when the longer name improves local understanding.

## Change discipline

- Preserve observable behavior unless the task explicitly changes it.
- Keep formatting-only, mechanical rename, and behavioral changes in separate commits.
- Do not perform broad cleanup while fixing an unrelated behavior.
- Prefer small modules with one owner. Treat files above 800 lines as split candidates and files above 1,200 lines as refactor hotspots, not automatic rewrite targets.
- Do not introduce a new dependency or public abstraction without recording the reason and validating ownership.

## Framework routing

| Path or concern     | Additional rule                |
| ------------------- | ------------------------------ |
| `sceneboard-mcp/**` | `rules/code/SCENEBOARD_MCP.md` |
| `sceneboard-be/**`  | `rules/code/NESTJS.md`         |
| `sceneboard-fe/**`  | `rules/code/NEXTJS.md`         |
| `packages/**`       | `rules/code/PACKAGES.md`       |

## Refactoring contract

1. Identify the observable behavior and its owning test surface.
2. Add or strengthen a regression test that fails for the targeted defect or unsupported change.
3. Run the focused test and confirm the expected failure before modifying production code.
4. Make the smallest production change that satisfies the test.
5. Run the focused test, affected package tests, typecheck, and the integration checks selected by `rules/qa/RULES.md`.
6. Review the diff for accidental API, data, security, localization, or runtime changes.

Do not call a change a refactor if it changes behavior without an explicit contract and acceptance test.
