# QA Rules

Use this branch for test planning, manual QA, browser QA, API QA, and release checks.

## Required Checks

- Prefer existing test harnesses and fixtures.
- Keep QA data isolated from production-like persistent data.
- If `rules/qa/PROJECT.md` exists, load it after this file.
- If a subproject-specific QA file exists under `rules/qa/`, load it when working under that subproject.
- For regressions, add a test that would have failed before the fix when feasible.
- Document manual verification steps when automation is not practical.

## Safety

- Do not permanently register outage/direct-monitor targets in production-like monitor DB tables.
- Clean up created test data with teardown or use mocks/isolated databases.
- Do not run build, deploy, restart, or destructive cleanup commands unless the user explicitly asks.

## Completion Note

When finishing QA-related work, report what was checked and what remains unverified.
