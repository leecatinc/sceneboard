# SceneBoard manual browser acceptance

Run this matrix only after `npm run check` passes in the same immutable
attempt. Use a fresh context for each principal and share generation. A manual
observation cannot override an automated failure.

| Case           |             Viewport | Required observations                                                                                                                                                                    |
| -------------- | -------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PAGES-DESKTOP  |             1440×900 | Latest is the first revision option; retained selection stays pinned; PageUp/PageDown, arrows, Home, and End honor editable/excluded targets; page change resets PAGE to top.            |
| PAGES-MOBILE-P |              320×568 | Fit width is readable, content stacks, bottom controls remain reachable, owner tools use the drawer, and the document has no horizontal scrollbar.                                       |
| PAGES-MOBILE-L |              568×320 | Explicit actual-size Move is clamped; vertical intent still scrolls PAGE/browser; back/forward navigation is not hijacked.                                                               |
| PRESENTATION   |             1440×900 | Fullscreen hides chrome, controls auto-hide and return, Escape/forced exit resync state, and focus fallback behaves equivalently when the API rejects.                                   |
| SHARING        |             1440×900 | Unlisted and password links show the pinned revision only; update, rotate, and revoke invalidate old access; public state never gains editor controls.                                   |
| MEDIA          | 1440×900 and 320×568 | Picker/drop upload places the same immutable image contract, decorative/meaningful fields are accessible, and failed upload leaves the document unchanged.                               |
| ANALYTICS      |             1440×900 | Only two-paint visible public/password content sends first-visible/page-visible; gates, hidden documents, errors, and authenticated Live Board send zero; no public count badge appears. |

For all rows verify one vertical scroll owner named `PAGE`, zero document X
overflow, visible focus, localized accessible names and announcements, and no
secret/path/cookie data in UI, URLs, logs, screenshots, or traces.

Record browser build hash, source commit, presentation manifest hash, case ID,
viewport, safe verdict, sanitized evidence hash, owner, and cleanup result.
Screenshots/traces/video default to off for password, token, analytics identity,
and local-file rows.

The I-44 source-contract smoke files under `e2e/` are deterministic and run in
CI. They do not impersonate this supervised browser matrix. When an installed
browser, authenticated principals, MySQL, or Redis are unavailable, record the
manual row as not executed and retain reduced assurance; never convert it to
PASS.
