# React Native Rules

Use for React Native, Expo, mobile app state/storage/sync, and device UI changes.

> The `TASK_PREFIX_START/END` block is read by headless task tooling. Keep the markers intact.

<!-- TASK_PREFIX_START v2 -->

## File Placement

- Put one-screen-only files near that screen or feature.
- Move code to shared folders only when there is real reuse.
- If a dedicated file needs to become shared, ask before moving it across ownership boundaries.

## State And Persistence

- Use the project's existing state model first.
- For persistent app data, prefer the established local storage/SQLite/Jotai storage pattern.
- For volatile UI state, keep it in memory state such as local state or memory atoms.
- Do not introduce a second persistence model without a clear local precedent.

## Offline And Sync

- User-created or user-edited data should remain usable locally when the app is offline.
- Server mutations should preserve enough local state for retry, conflict handling, or explicit failure.
- Do not discard local changes just because a network request fails.

## Auth And Local Security

- Do not store raw OAuth tokens, refresh tokens, auth codes, passwords, OTPs, provider raw profiles, or secrets in SQLite.
- Use secure storage such as SecureStore, Keychain, or Keystore for sensitive auth/session values when the project supports it.
- Store only opaque references or masked metadata in regular local DB tables.

## Color And Styling

- Use project color tokens such as `colors.ts` when available.
- Avoid hardcoded colors and one-off style constants.
- Respect device locale and timezone for display.

## Date And Time

- Treat API dates as UTC ISO 8601 unless the API contract says otherwise.
- Display dates in the device timezone.
- Send dates to the server in UTC.
- Prefer existing project date utilities before adding new formatting logic.

<!-- TASK_PREFIX_END -->
