# React Frontend Rules

Use for React/Vite/frontend changes.

> The `TASK_PREFIX_START/END` block is read by headless task tooling. Keep the markers intact.

<!-- TASK_PREFIX_START v2 -->

## Components And State

- Match the existing component, hook, and state-management patterns.
- Keep reusable logic in existing shared locations only when it is actually reused.
- Keep screen/page-only logic near the screen or page.
- Preserve local naming and file organization conventions.

## CSS And Styling

- Do not pile feature-specific styles into global CSS.
- Keep global CSS for variables, resets, fonts, and app-wide primitives.
- Put screen/page layout styles near the screen/page.
- Put reusable component styles with the component.
- Split CSS files that grow past roughly 800 lines when practical.
- Use project tokens/constants when they exist instead of hardcoded colors or spacing.

## Date And Time

- Treat API dates as UTC ISO 8601 unless the API contract says otherwise.
- Display dates in the browser/user timezone.
- Send dates to the server in UTC.
- Prefer existing project date utilities before adding new formatting logic.

## Verification

- Run focused frontend/unit tests when available.
- For browser-visible behavior, verify the relevant UI state when practical.

<!-- TASK_PREFIX_END -->
