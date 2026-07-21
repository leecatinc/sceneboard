# QA Rules

## Test-first regression workflow

- For a defect or behavior-preserving refactor, add or strengthen the closest regression test before changing production code.
- Confirm that the new test fails for the intended reason. If a destructive setup makes a red run unsafe, document the constraint and use an isolated reproduction.
- After the change, run the focused test first, then the affected package test and typecheck commands.
- For cross-package contracts, run both producer and consumer tests plus the relevant integration or browser scenario.
- A passing build alone is not QA.

## Package commands

Run commands from the affected package until a unified monorepo command is introduced:

- MCP: `npm test`, `npm run typecheck`, and `npm run build` when build output changes.
- Backend: `npm test`, `npm run typecheck`, and the relevant isolated database/integration checks.
- Frontend: `npm test`, `npm run typecheck`, and `npm run build` for routing, bundling, CSP, or production-render changes.
- Shared package: `npm test`, `npm run typecheck`, and affected consumer tests.

## Safety and evidence

- Never point destructive QA at production data or production-like persistent stores.
- Keep fixtures deterministic and redact secrets and personal data from logs, screenshots, and recordings.
- Record the commands, result, and any unverified surface in the completion report.
- Do not use `npx`; use package scripts or local binaries.
