# Code Conventions (implementation-time)

Consumed at IMPLEMENTATION time: implementation, optimization, and test work loads
this branch via `rules/code/RULES.md` routing before touching source code.
Planning-time structure rules (layout, layers, API shapes) live in
`rules/code/STRUCTURE.md` — they are fixed by the plan, not re-decided here.

## Tool-Enforced First (formatter/linter are the SoT, not this file)

- Indentation, quotes, semicolons, line width, and import sorting are the job of the
  project's formatter/linter/compiler configs (Prettier / ESLint / tsconfig or
  equivalents). Where configs exist they are the source of truth — this file never
  overrides them.
- Passing lint + format + typecheck is part of the completion condition of every
  implementation/optimization task.
- Only rules tools cannot enforce belong in this file: naming semantics, error
  contracts, layer discipline, logging hygiene.

## Naming Semantics

- Functions verb-first (`createOrder`, `validateInput`); booleans read as predicates
  (`isExpired`, `hasStock`, `canCancel`).
- No abbreviations that are not project-established; no single-letter names outside
  tiny lambda/index scopes.
- True constants UPPER_SNAKE_CASE; everything else camelCase (components PascalCase).

## Error Handling Contract (team-uniform — highest drift cost)

- One error class hierarchy per project, in the shared location: an `AppError`-style
  base carrying `(statusCode, message, code)` plus narrow subclasses
  (`BadRequestError`, `NotFoundError`, `ConflictError`, ...). Never throw raw
  strings or bare `Error` for expected failures.
- The HTTP error envelope is uniform across every route:
  `{ "error": { "code": "<MACHINE_CODE>", "message": "<human message>" } }` —
  produced by the central error middleware/filter, never shaped per-handler.
- Status codes follow one decision table: 400 malformed input · 401 unauthenticated
  (token-renew retry once) · 403 unauthorized (never conflated with 401) · 404
  missing resource · 409 state conflict/duplicate · 422 semantically invalid (pick
  409-vs-422 once per project and keep it everywhere) · 429 rate limit with a
  `Retry-After` header · 5xx never leaks internals (stack/SQL/config go to logs only).
- Retry semantics callers may rely on: 429/502/503/504 are retryable with backoff
  (+`Retry-After` when present); other 4xx are not (401 renew-once is the only
  exception).

## Paradigm Discipline (FP/OOP — apply only the axes the language supports)

OOP axis (interface/class-capable languages):

- Consumers depend on the narrowest contract available: inject interfaces/tokens,
  not concretions; narrow wide config/objects with `Pick`-style views where the
  language allows.
- Per-variant behavior via polymorphism (strategy / registry / null-object), not
  type-switch conditionals — extension means adding an implementation, never
  editing a dispatcher.
- No test-convenience leakage into production signatures: no public mutable test
  seams, no default no-op collaborators, no `X | string`-style unions that
  silently weaken a required dependency. Tests build their own fixtures/helpers;
  missing wiring must fail loudly at boot, not run silently degraded.

FP axis (languages with first-class functions):

- Pure transformation layer separated from I/O: parsing / normalization /
  decision functions take data and return data; effects (HTTP, fs, DB, clock,
  logging) enter as injected capabilities at the edges.
- Errors as values at data boundaries (Result / discriminated unions);
  exceptions are reserved for infrastructure failures and carry typed context.
- Callbacks handed to `map`/`filter`/`reduce` stay side-effect-free — no counter
  mutation or collection pushes inside a predicate; partition first, then count.
- Domain types default to immutable (`readonly` fields/arrays where available).
  Deliberately-stateful components (buffers, mutexes, caches, queues) are
  allowed but must be encapsulated, bounded, and named/documented as stateful.

## Import Order (only when no linter rule exists)

- node builtins → external packages → internal absolute aliases → relative paths,
  one blank line between groups. Where an ESLint import-order rule exists, that
  rule wins (Tool-Enforced First).

## Logging

- Use the project's logger, not `console.*`, when one exists. Levels: `error` =
  broken invariant, `warn` = degraded but continuing, `info` = state change,
  `debug` = diagnostics.
- Never log secrets, tokens, passwords, or full auth headers; truncate large
  payload dumps.

## Tests

- Location/naming per the pattern STRUCTURE.md recorded for the project; structure
  test bodies Arrange-Act-Assert; test names state the behavior
  ("rejects cancel on an already-cancelled order"), not the method name.
- **Quality bar**: a test must go red when its covered behavior breaks. No
  tautologies (asserting values the test itself created); no implementation
  mirroring (dependency versions, manifest snapshots, DI metadata counts,
  internal constants — wiring is verified by real-graph boot, behavior by
  observable output; ordering asserts only for real contracts). One behavior
  rule is owned by exactly one spec — other levels keep at most one
  representative smoke. Before writing a regression guard, search for an
  existing owner spec first; already-covered behavior gets no new test.

## Dependency Policy

- Install only dependencies the plan lists. A dependency discovered as needed
  mid-implementation must be surfaced (deviation note / user confirmation per the
  active workflow) — never a silent install.

## Owned Elsewhere (do not restate here)

- Comment policy, file size, build/restart ban, rollback ban →
  `rules/code/RULES.md` HEADLESS block.
- Commit/branch rules → `rules/git/RULES.md`.
- Env/secret handling → `rules/env/RULES.md`.
- QA/test-run procedures → `rules/qa/RULES.md`.
