# Code Structure Rules (planning-time)

Consumed at PLANNING time: detailed planning (planning MD authoring — target files,
design, acceptance criteria) and plan reviews check the work's target files/folders
against this file. Folder layout, layer boundaries, and API shapes are fixed by the
plan's target-file list and design — implementation cannot repair a structure the
plan got wrong, so a violation found here is a plan defect, not a code defect.

> Implementation-time conventions (naming semantics, error patterns, imports,
> logging) live in `rules/code/CONVENTIONS.md`. Framework specifics live in the
> KOA / REACT / REACT_NATIVE branches.

## Folder Layout

- Follow the project's existing layout first. Do not introduce a new top-level
  folder without a plan-recorded reason.
- Fresh backend default: `src/routes|controllers → src/services →
  src/repositories|models`, with shared code under `src/common/` (errors, utils,
  middlewares, types).
- Tests: colocated `*.test.ts`/`*.spec.ts` OR a `test/` mirror tree — adopt the
  project's existing pattern; never mix both in one package. The first plan that
  introduces tests records the choice.

## Layer Boundaries

- Dependency direction is one-way: `route/controller → service → repository/model`.
  Reverse imports (a service importing a controller, a repository importing a
  service) are forbidden.
- Controllers/route handlers: parse + validate input at the boundary, call services,
  shape the HTTP response. No business logic, no direct data access.
- Services: business logic only. No HTTP-specific types (`req`/`res`/`ctx`) in
  service signatures.
- Repositories/models: data access only. No business decisions.
- Cross-cutting concerns (auth, logging, error envelope) live in shared
  middleware/common — never re-implemented per route.

## Shared Utilities (duplicate prevention)

- One canonical location for shared helpers (`src/common/` or the project's
  equivalent). A detailed plan that needs a helper MUST state whether it already
  exists or is created by this work — and when created, which issue owns the file.
  Two parallel issues must never both create the same helper.
- Parallel issues share contracts through planned shared files, never through
  copy-paste between issues.

## File Size & Split (planning view)

- Plan file boundaries so the size policy holds (target 500–800 lines, split above
  1200 — same numbers as the code rules HEADLESS block). If a plan's target file
  would exceed the cap, the split belongs in the plan itself, not in a follow-up.

## File & Folder Naming

- Follow the project's dominant pattern first. Fresh defaults: folders and
  non-component files kebab-case (or the ecosystem's norm); React components
  PascalCase; one exported main concept per file, filename matching it.
- Use role suffixes when the project does: `*.service.ts`, `*.repository.ts`,
  `*.controller.ts`, `*.middleware.ts`.

## API Design Contract (fixed at plan time)

- Resource URLs use plural nouns (`/orders`, `/orders/:id`). Non-CRUD actions get a
  documented sub-resource or verb path recorded in the plan.
- Pagination / filtering / sorting parameter names are decided ONCE per project and
  reused; the first plan introducing a list endpoint records them.
- Dates in API payloads: ISO 8601 UTC strings.
- Error responses follow the error contract in `rules/code/CONVENTIONS.md`
  (uniform envelope + status-code decision table). Plan acceptance criteria state
  the expected status codes explicitly (e.g. "duplicate create → 409").
