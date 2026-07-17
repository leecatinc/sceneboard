# Koa Backend Rules

Use for Koa/Node backend changes.

> The `TASK_PREFIX_START/END` block is read by headless task tooling. Keep the markers intact.

<!-- TASK_PREFIX_START v2 -->

## Architecture

- Follow the existing route -> controller -> model/service structure.
- Keep route handlers thin and move business logic to the existing service/helper layer.
- Match existing response shapes, error handling, auth, and permission patterns.
- Validate request parameters at the boundary before service calls.

## Data And Database

- Use the project's established DB helpers and query builders. Avoid raw SQL unless local code already requires it.
- Treat delete operations as soft delete by default. Use the project's existing field, such as `deleted_at` or a status flag, and exclude deleted rows from reads.
- Cascade soft-delete related child data when the domain expects it.
- Ask for explicit confirmation before physical deletion.
- When using hdbMysql-style insert/update helpers, do not pass `new Date()` objects directly; pass formatted date strings from project utilities.

## Date And Time

- Store dates using the project's established DB timezone convention.
- Return API dates as UTC ISO 8601 when the frontend consumes them.
- Do not do final display-timezone formatting on the server; client display is the frontend's responsibility.
- Keep KST and UTC comparisons explicit so mixed timezone calculations do not slip in.

## API And Auth

- Use standard response helpers when the project has them, such as `hlibs/response.ts`.
- Keep JWT/session renewal behavior aligned with the existing middleware.
- Do not hardcode runtime config or secrets. For config/env changes, also load `rules/env/RULES.md`.

## QA And Tests

- For QA/test work, also load `rules/qa/RULES.md` and routed QA project/subproject rules.
- Tests must not permanently register outage/direct-monitor targets in production-like monitor DB tables. Clean them up with teardown or use mocks/isolated DBs.
- Run focused backend tests when available. For API behavior changes, include request/response or route-level coverage when practical.

<!-- TASK_PREFIX_END -->
