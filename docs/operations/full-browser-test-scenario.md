# SceneBoard full browser test scenario

This document defines one comprehensive browser run against the SceneBoard
development server, covering public pages, authentication, user settings, AI
connections, boards, scenes, Human-in-the-Loop (HITL), artifacts, revisions,
and error recovery.

It validates both product surfaces:

- the real browser interface used by a person; and
- the 21 protected operations that change browser-visible state through an
  approved SceneBoard connection.

Static copy alone is not evidence of success. Verify stored server state,
browser rendering, and interaction results separately.

## 1. Execution objectives

One run must answer these questions:

1. Can a new user sign up and log in safely?
2. Do the browser language and saved language preference apply correctly?
3. Is a one-time code bound to exactly one connection and its new board?
4. Are prior pairings and prior boards excluded from a new connection?
5. Does AI work appear live as scenes, HITL, artifacts, and revisions?
6. Do board viewing, navigation, zoom, pan, and recovery work in a real browser?
7. Are reduced permissions, expiry, revocation, and invalid input handled safely?
8. Are non-account test data and connections cleaned up at the end?

## 2. Target environment and run variables

The development server is the default target.

```text
SCENEBOARD_BASE_URL=https://sceneboard.leecat.co.kr
SCENEBOARD_ARTIFACT_URL=https://sceneboard-artifact.leecat.co.kr
SCENEBOARD_OUTPUT_DIR=/workspace/.tmp/agent/browser-use/sceneboard-full-browser
```

For production verification, change only the URLs:

```text
SCENEBOARD_BASE_URL=https://sceneboard.dev
SCENEBOARD_ARTIFACT_URL=https://artifact.sceneboard.dev
```

Never store a password, session cookie, CSRF token, or connection credential in
the scenario, logs, screenshots, or HTML. Routine regression uses a reusable
dedicated QA account; signup verification alone uses a unique test email for
each run.

## 3. Verdict criteria

### PASS

- Every required case meets its expected result.
- Browser `pageerror` count is zero.
- Console error count is zero except for intentionally induced 4xx cases.
- The browser URL `boardId`, API `boardId`, and grant-approved `boardId` match.
- All test data is cleaned up or isolated in dedicated QA boards.

### FAIL

- The browser redirects to the wrong board.
- The UI shows success without a successful response.
- A HITL answer is stored but not delivered to the caller.
- A scene or artifact is stored while the browser remains on a safe-stop page.
- Scenes, revisions, or connection state from different boards are mixed.
- A credential, cookie, or token appears in the DOM, console, network URL, or
  artifact runtime.

### BLOCKED

- Required human input such as email receipt, CAPTCHA, or external account
  approval is unavailable.
- A development component is down, preventing a meaningful verdict.
- The test account or approval authority is unavailable.

## 4. Shared safety rules

1. Use headless Chromium by default.
2. Before sending real email, changing a password, revoking a connection, or
   deleting a board, confirm that the case explicitly authorizes that exact
   test data.
3. Every mutation uses a unique `idempotencyKey` and the most recently read
   `expectedRevisionId`.
4. After mutation failure, do not switch transports or invent a new identifier.
5. On `REVISION_CONFLICT`, reread the latest head and reevaluate intent. Never
   retry blindly.
6. Record artifact publication and browser rendering as separate outcomes.
7. Count HITL as visible only after both an actual `open` request and its browser
   card are confirmed.
8. Store test output only below `/workspace/.tmp/agent/browser-use/`.
9. Perform destructive cleanup only in the final phase.

## 5. Preflight

| ID     | Action                                            | Expected result                                           |
| ------ | ------------------------------------------------- | --------------------------------------------------------- |
| PRE-01 | Request app root and artifact `/healthz`/`runner` | App 200, artifact health 200, runner 200                  |
| PRE-02 | Inspect PM2 or deployment state                   | Next, Nest, MCP, and artifact runtime are healthy         |
| PRE-03 | Run browser environment doctor                    | Playwright and Chromium can run                           |
| PRE-04 | Create a fresh browser context                    | No prior cookies, localStorage, or sessionStorage         |
| PRE-05 | Install console/pageerror/requestfailed capture   | Error evidence can be captured without sensitive data     |
| PRE-06 | Create a test run ID                              | Accounts, connections, boards, and keys cannot cross runs |

## 6. Phase A — Public pages and localization

| ID     | Action                                                       | Expected result                                                      |
| ------ | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| PUB-01 | Open `/` while signed out                                    | Public landing renders without authentication or broken requests     |
| PUB-02 | Open `/login`, `/signup`, and `/integrations/codex` directly | Each returns 200 with no broken bundle request                       |
| PUB-03 | Open a fresh context whose browser language is Korean        | Korean is selected when no preference is stored                      |
| PUB-04 | Select all ten supported locales                             | Primary navigation and forms change to the selected locale           |
| PUB-05 | Select Korean, reload, and open a new tab                    | Stored language overrides browser language                           |
| PUB-06 | Remove stored language and test regional locale tags         | `pt-BR`, `zh-CN`, and `zh-TW` map to the correct supported locale    |
| PUB-07 | Use the Codex install-page copy button and ZIP link          | Copy state appears; ZIP is HTTP 200 and nonempty                     |
| PUB-08 | Inspect installation ZIP contents                            | Plugin manifest, MCP launcher, skill, API fallback, and demo exist   |
| PUB-09 | Operate every landing workflow node and edge by keyboard     | Details dialog opens, traps focus, closes, and restores the opener   |
| PUB-10 | Select the landing workflow JSON                             | Full canonical JSON is selected without clipboard authority          |
| PUB-11 | Repeat landing checks at 320x568 and 568x320                 | Header, graph controls, labels, JSON, and terminal CTA remain usable |
| PUB-12 | Enable reduced motion on the landing                         | Graph motion is disabled while every control remains operable        |

## 7. Phase B — Signup, email verification, and login

Signup email changes external state, so run it only with an approved
development address. Routine regression begins at `AUTH-07` with an already
verified QA account.

| ID      | Action                                             | Expected result                                               |
| ------- | -------------------------------------------------- | ------------------------------------------------------------- |
| AUTH-01 | Request a verification code for an invalid email   | Localized validation error; no account                        |
| AUTH-02 | Request a code for a unique approved test email    | Gmail send succeeds or approved dev-DB route obtains the code |
| AUTH-03 | Submit an incorrect code                           | Safe error; no account or session                             |
| AUTH-04 | Submit the correct code                            | Email becomes verified                                        |
| AUTH-05 | Try a 9-character or over-72-byte UTF-8 password   | Creation blocked with policy guidance                         |
| AUTH-06 | Sign up with a valid password of at least 10 chars | Account created and authenticated session established         |
| AUTH-07 | Log out and submit an incorrect password           | Uniform error that does not reveal account existence          |
| AUTH-08 | Submit the correct password                        | Board list opens; session survives reload                     |
| AUTH-09 | Log in/reload concurrently in two tabs             | One coherent renewal; no renew or logout loop                 |
| AUTH-10 | Open a protected URL in a signed-out context       | Redirects to login without exposing session or board data     |

## 8. Phase C — Account menu and settings

| ID     | Action                                             | Expected result                                                   |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| SET-01 | Open the top-right account area                    | Only email, settings, password change, and logout appear          |
| SET-02 | Open user settings                                 | Modal appears without navigation                                  |
| SET-03 | Change language, close, and reload                 | Locale persists and focus is restored                             |
| SET-04 | Open password change                               | Modal appears without navigation                                  |
| SET-05 | Submit an incorrect current password               | Safe error; password and session unchanged                        |
| SET-06 | Submit the same or a policy-invalid new password   | Change blocked                                                    |
| SET-07 | Change password on the explicitly approved account | Current browser remains; other sessions/connections follow policy |
| SET-08 | Log in again with the new password                 | New password succeeds; old password fails                         |
| SET-09 | Log out                                            | Protected data removed; Back cannot reveal a board                |

When routine regression does not change a password, record `SET-07` and
`SET-08` explicitly as `NOT RUN — destructive account test`.

### 8.1 Account API-key lifecycle

API keys are separate from paired client credentials. Create only
attempt-owned keys, never record their raw value in evidence, and revoke them
during cleanup.

| ID     | Action                                                        | Expected result                                                        |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| KEY-01 | Open API-key management while loading, empty, and failed      | Distinct progress, empty, retryable error, and terminal error states   |
| KEY-02 | Open Create key at 1440x900 and 320x568                       | All 11 canonical scopes render; only `board:read` is selected          |
| KEY-03 | Deselect all scopes with pointer and keyboard                 | Submit stays disabled and no empty-scope request is sent               |
| KEY-04 | Select all scopes                                             | Canonical ordering is preserved in the submitted payload               |
| KEY-05 | Create a minimally scoped key                                 | Secret dialog opens once, receives focus, and supports safe copy       |
| KEY-06 | Close the one-time secret dialog and reopen the existing row  | Raw key never reappears in DOM, storage, URL, console, or network logs |
| KEY-07 | Use a key with one allowed and one omitted neighboring action | Allowed action succeeds; omitted action is forbidden with no mutation  |
| KEY-08 | Exercise newly added publish, control, HITL, and media scopes | UI selection and server authorization remain exactly aligned           |
| KEY-09 | Revoke only the attempt-owned key                             | Key becomes unusable; other keys and paired clients remain unchanged   |
| KEY-10 | Use long names and keyboard-only operation at 320x568         | No horizontal clipping; controls are reachable and at least 44px high  |

## 9. Phase D — AI connection codes and pairing

Run this phase once with no existing connections and once with an existing
connection retained.

| ID      | Action                                              | Expected result                                                    |
| ------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| PAIR-01 | Click `Create connection code` in the top bar       | Modal shows `SB-XXXXXX-XXXXXX`                                     |
| PAIR-02 | Copy the code                                       | Clipboard-success toast appears                                    |
| PAIR-03 | Close and reopen the modal                          | Valid code state persists or refreshes explicitly per contract     |
| PAIR-04 | Cancel the unused code                              | Code becomes unclaimable                                           |
| PAIR-05 | Pair through official MCP or API fallback           | One pending row appears and detail modal opens automatically       |
| PAIR-06 | Inspect all requested capabilities                  | Seven scopes plus `board.create` and `board.archive` appear        |
| PAIR-07 | Approve with `New board` selected by default        | Board is created only on approval; browser opens exact `boardId`   |
| PAIR-08 | Compare URL, API result, and grant board list       | All match; no prior board is included                              |
| PAIR-09 | Search and select an existing board                 | Search works; connection targets only that exact board             |
| PAIR-10 | Pair a session without a board, then `board_create` | Returned board is atomically added to the same grant               |
| PAIR-11 | Deny a request                                      | No credential; request reaches terminal `denied`                   |
| PAIR-12 | Cancel the request code                             | Approval is impossible; list shows terminal state                  |
| PAIR-13 | Rotate an approved client credential                | Old credential is invalid; only the new one works                  |
| PAIR-14 | Revoke an approved client                           | Protected operations fail safely as unauthenticated or forbidden   |
| PAIR-15 | Pair while another connection exists                | New connection does not inherit the previous connection's board ID |

`PAIR-07`, `PAIR-08`, and `PAIR-15` are mandatory gates for prior-board
contamination regressions.

## 10. Phase E — Board list and lifecycle

| ID       | Action                                                  | Expected result                                              |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| BOARD-01 | Open list for an account with no boards                 | Clear empty state; no error copy                             |
| BOARD-02 | Create a QA board with `board_create`                   | Appears immediately using returned ID                        |
| BOARD-03 | AI creates a board while browser is on list/connections | Browser automatically opens the new board                    |
| BOARD-04 | AI creates a board while browser shows another board    | Browser remains on current board without forced navigation   |
| BOARD-05 | Edit title with the pencil control                      | Header, list, and reloaded value agree                       |
| BOARD-06 | Create and switch among at least two boards             | Scenes, revisions, and connections never mix                 |
| BOARD-07 | Click delete, then cancel                               | Board remains                                                |
| BOARD-08 | Confirm deletion                                        | Archive, return to list, direct URL reveals no private state |
| BOARD-09 | AI archives the current board                           | Current browser returns to the board list                    |
| BOARD-10 | Exercise `board_list` `includeArchived` branches        | Hidden when false; visible only as archived when true        |

## 11. Phase F — Connection state and capabilities

| ID       | Action                                            | Expected result                                 |
| -------- | ------------------------------------------------- | ----------------------------------------------- |
| GRANT-01 | Call `board_connection_status` with a null target | Returns auth state without selecting a board    |
| GRANT-02 | Query status for an explicit board                | Shows exact board and approved scopes           |
| GRANT-03 | Call `board_capabilities_get`                     | Server capabilities match the UI status sidebar |
| GRANT-04 | Read through a read-only connection               | Read succeeds                                   |
| GRANT-05 | Mutate through a read-only connection             | `FORBIDDEN`; scene unchanged                    |
| GRANT-06 | Publish without artifact capability               | `FORBIDDEN`; no immutable artifact              |
| GRANT-07 | Create without approved `board.create`            | `FORBIDDEN`; existing boards unchanged          |
| GRANT-08 | Observe an open board immediately after revoke    | AI presence disappears; human session remains   |

## 12. Phase G — Scene rendering and live updates

Judge mutation success and browser rendering separately for every row.

| ID       | Action                                                 | Expected result                                     |
| -------- | ------------------------------------------------------ | --------------------------------------------------- |
| SCENE-01 | First visit to a new board                             | Intended empty canvas with no error copy            |
| SCENE-02 | Replace with markdown, code, and status nodes          | Complete scene renders in one revision              |
| SCENE-03 | Add table, chart, map, drawing, and progress nodes     | Every trusted node preserves meaning                |
| SCENE-04 | Add split, grid, tabs, and canvas layouts              | No overlap or off-screen disappearance              |
| SCENE-05 | Patch part of a text node and a tab                    | Other node IDs and content remain                   |
| SCENE-06 | Replay the same mutation with the same key             | Only byte-identical replay; no duplicate revision   |
| SCENE-07 | Reuse the key with another payload                     | `IDEMPOTENCY_KEY_REUSED`; scene unchanged           |
| SCENE-08 | Use a stale `expectedRevisionId`                       | `REVISION_CONFLICT`; new head preserved             |
| SCENE-09 | Run `board_scene_clear`                                | Empty canvas becomes a new restorable revision      |
| SCENE-10 | Perform three consecutive live updates while connected | Sequence and revision increase without reload       |
| SCENE-11 | Briefly disconnect and restore SSE                     | Reconnects to latest head without duplicate scene   |
| SCENE-12 | Reload the browser                                     | Same board/live head; no chunk, MIME, or CORS error |
| SCENE-13 | Observe the same board from two tabs                   | Changes propagate consistently                      |

## 13. Phase H — All HITL types and lifecycle states

For each request, first verify server state `open`, then its decision-tray or
inline-card rendering.

| ID      | Action                                                     | Expected result                                                    |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| HITL-01 | Create an `info` request                                   | Person acknowledges through the allowed response shape             |
| HITL-02 | Create a single-select `choice` request                    | Exactly one option; exact option ID delivered                      |
| HITL-03 | Create a multi-select `choice` request                     | Min/max validated; out-of-range submission blocked                 |
| HITL-04 | Create a `form` request                                    | Required/optional fields and validation work                       |
| HITL-05 | Create and confirm a `confirmation` request                | Delivers `confirmed:true`                                          |
| HITL-06 | Choose cancel inside confirmation                          | Delivers `confirmed:false`; not confused with request cancellation |
| HITL-07 | Request HITL without an explicit `content.hitl` scene node | Card appears in the automatic decision tray                        |
| HITL-08 | Place an inline card for the exact request ID              | Appears at target without a duplicate response card                |
| HITL-09 | Use bounded wait after browser response                    | Caller receives `answered` and exact response                      |
| HITL-10 | Reload after answering                                     | Answer persists and cannot be resubmitted                          |
| HITL-11 | Respond again to an answered request                       | `HITL_RESPONSE_CONFLICT`; existing answer preserved                |
| HITL-12 | Query an unknown request ID                                | `HITL_REQUEST_NOT_FOUND`; board remains safe                       |
| HITL-13 | Wait on a short-lived test request                         | Reaches `expired`; controls disabled                               |
| HITL-14 | Exercise server-only cancel/supersede lifecycle paths      | Correct terminal UI; no arbitrary model-facing cancel tool         |
| HITL-15 | View a past open card in history                           | Response controls are hidden in historical revision                |

## 14. Phase I — Artifacts and isolated runtime

| ID     | Action                                 | Expected result                                                 |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| ART-01 | Publish an approved closed template    | Immutable `artifactId/versionId`; runtime `ready`               |
| ART-02 | Place the exact artifact node in scene | `.artifact-host.artifact-active`; exactly one iframe            |
| ART-03 | Run 2D Canvas drawing animation        | Lines appear progressively, then settle                         |
| ART-04 | Render colored illustration            | Outline revision remains; color result renders                  |
| ART-05 | Run 3D paper diorama                   | Pointer changes depth/tilt; no external network                 |
| ART-06 | Run interactive prototype              | Click changes state; reset/replay work                          |
| ART-07 | Run data story                         | Chart and conclusion share one screen; replay works             |
| ART-08 | Run incident simulation                | Transitions healthy → failure → recovery                        |
| ART-09 | Run code-review visual                 | Review/final stages and user choice appear                      |
| ART-10 | Select Fit height                      | Fills vertical space without vertical clipping                  |
| ART-11 | Select Fit width                       | Fits width without unintended horizontal clipping               |
| ART-12 | Wheel in Actual size                   | Cursor-centered zoom; canvas action replaces page scroll        |
| ART-13 | Middle-button drag in Actual size      | Pans canvas coordinates                                         |
| ART-14 | Reset view                             | Restores initial zoom and pan                                   |
| ART-15 | Stop rendering                         | Runtime stops from status sidebar while scene reference remains |
| ART-16 | Move between past revision and Latest  | Exact immutable versions rerender                               |
| ART-17 | Inspect artifact-runtime domain        | No app cookie, Authorization, or Referer transmitted            |
| ART-18 | Inspect sandbox and CSP                | No capability beyond `allow-scripts`; external scripts blocked  |
| ART-19 | Use an invalid artifact identifier     | Safe fallback; no credential or payload exposure                |
| ART-20 | Request an unapproved capability       | `CAPABILITY_DENIED`; no automatic approval                      |

## 15. Phase J — Revision time travel

| ID      | Action                                    | Expected result                                                  |
| ------- | ----------------------------------------- | ---------------------------------------------------------------- |
| HIST-01 | Create at least four meaningful revisions | Newest-first history; unique numbers and IDs                     |
| HIST-02 | Use `Previous`, `Next`, and `Latest`      | Labels and enabled state match historical/live state             |
| HIST-03 | Navigate with left/right arrows           | Revision changes only outside input controls                     |
| HIST-04 | Navigate with PageUp/PageDown             | Revision changes without conflicting with page scroll            |
| HIST-05 | Mutate live while viewing history         | Pinned revision remains; Latest becomes available                |
| HIST-06 | Select Latest                             | Converges to current head and resumes live tracking              |
| HIST-07 | Call `board_history_get`                  | Exact scene matches browser revision                             |
| HIST-08 | Approve restoration of a past revision    | Past scene copies forward to new head; history remains immutable |
| HIST-09 | Select Previous after restore             | Pre-restore head and original past revision remain accessible    |
| HIST-10 | Request a nonexistent revision            | `REVISION_NOT_FOUND`; current screen remains safe                |

## 16. Phase K — Responsive, accessible, resilient browser behavior

| ID    | Action                                                   | Expected result                                              |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------ |
| UX-01 | Run at 1440x900, 1180x900, 760x900, 320x568, and 568x320 | Core features accessible; modals remain in viewport          |
| UX-02 | Set browser zoom to 200%                                 | Reflow or internal scroll without feature loss               |
| UX-03 | Navigate by keyboard only                                | Visible focus, logical order, modal focus trap/restore       |
| UX-04 | Enable `prefers-reduced-motion`                          | Meaning remains while decorative motion decreases            |
| UX-05 | Enable forced colors                                     | Text, controls, and selected state remain distinguishable    |
| UX-06 | Use long email and board title                           | Top bar/card overflow does not break layout                  |
| UX-07 | Use modal Escape and close controls                      | Save/cancel semantics remain distinct from code cancellation |
| UX-08 | Simulate a slow network                                  | Loading state visible; no duplicate mutation                 |
| UX-09 | Go offline, then online                                  | Safe retry and session/SSE recovery                          |
| UX-10 | Force reload with a stale Next chunk                     | Current assets load without MIME error                       |

## 17. Phase L — Error contracts and security regression

Run intentional errors in a separate context or API client so they do not
contaminate normal-screen console criteria.

| ID     | Action                                             | Expected result                                                 |
| ------ | -------------------------------------------------- | --------------------------------------------------------------- |
| ERR-01 | Use an invalid session or credential               | 401 and `UNAUTHENTICATED`; correlation retained                 |
| ERR-02 | Use a valid but unauthorized board ID              | `FORBIDDEN` or non-disclosing not-found response                |
| ERR-03 | Send malformed payload                             | `INVALID_PAYLOAD`; no stack or DB details                       |
| ERR-04 | Send stale-revision mutation                       | `REVISION_CONFLICT`; no automatic rebase                        |
| ERR-05 | Drop mutation response, then query with same key   | Durable state decides outcome; no duplicate mutation            |
| ERR-06 | Induce temporary API 5xx                           | Safe stop/retry UI; no automatic transport switch               |
| ERR-07 | Compare allowed and disallowed CORS origins        | Only development app origin allowed                             |
| ERR-08 | Inspect artifact iframe request headers            | No session cookie, CSRF, Authorization, or referrer             |
| ERR-09 | Scan DOM, console, and stored HTML for secrets     | No raw password, code, credential, or cookie                    |
| ERR-10 | Update open HITL/artifact during reload            | No `durable ... event has no stable target` error               |
| ERR-11 | Open empty board and board immediately after clear | Intended empty canvas, not `Scene unavailable`                  |
| ERR-12 | Test immediately before artifact limit             | In-limit succeeds; excess preserves state with `LIMIT_EXCEEDED` |

## 18. Phase M — Cleanup and exit

| ID       | Action                       | Expected result                                           |
| -------- | ---------------------------- | --------------------------------------------------------- |
| CLEAN-01 | Inspect open HITL requests   | Answered or intended terminal state; nothing left open    |
| CLEAN-02 | Stop test artifact rendering | Runtime resources released; browser remains responsive    |
| CLEAN-03 | Revoke test connections      | Protected credentials become invalid                      |
| CLEAN-04 | Archive test boards          | Removed from list without affecting another user's boards |
| CLEAN-05 | Log out and close context    | No cookie, storage, cache, or service worker remains      |
| CLEAN-06 | Run final health check       | App and artifact runtime are healthy                      |

The UI contract has no account-deletion flow for signup-only accounts, so do
not automate it. Retain or remove unique test accounts under the operating
policy.

## 19. Recommended automation structure

Split the full run into suites rather than one large function:

```text
browser-full/
  00-preflight
  01-public-locale
  02-auth-settings
  03-pairing-grants
  04-board-lifecycle
  05-scene-live
  06-hitl
  07-artifacts
  08-history
  09-responsive-accessibility
  10-errors-security
  11-cleanup
```

The repository owns three distinct evidence classes and must report them
separately:

| Evidence class                 | Command / location                             | Gate rule                                                         |
| ------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| Self-contained Chromium        | `npm run test:browser:c10` / `e2e/*.test.mjs`  | Runs in `npm run check`; zero skips and zero browser errors       |
| Live disposable-environment UI | `npm run test:browser:live` / `test/browser/*` | Requires both fixture URLs and fails closed when either is absent |
| Contract/certification         | `npm run test:certification` / `test/e2e/*`    | May prove API/runtime contracts but is not counted as UI evidence |

Files that only inspect source text remain useful as static contract tests,
but they must not be counted as browser E2E coverage or used as the sole
evidence for focus, layout, rendering, or user interaction.

### 19.1 Current browser automation coverage and open gates

| Journey                                        | Current executable evidence                                      | Status / remaining requirement                                       |
| ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Public landing graph and workflow JSON         | `e2e/landing-graph-engineering.test.mjs`                         | Automated at desktop, portrait, landscape, keyboard, CSP, and motion |
| API-key create-sheet scope selection           | `e2e/api-key-create-sheet-browser.test.mjs`                      | Automated component seam; live create/use/reload/revoke remains      |
| Artifact host capability and clipboard         | `e2e/artifact-host-behavior.test.mjs`, clipboard/authority tests | Automated host seam; real board hydration/revocation remains         |
| Workflow artifact rendering                    | `e2e/workflow-graph-artifact.test.mjs`                           | Automated generated runtime; real board composition remains          |
| Board page/mobile/presentation/public artifact | `test/browser/*.spec.ts`                                         | Live-fixture suite; release environment must supply isolated URLs    |
| Pairing to exact board plus live update        | API certification and manual scenario only                       | Open P0 browser journey                                              |
| History, reconnect, HITL, error recovery       | Contract tests and manual scenario only                          | Open P1 integrated browser journey                                   |
| Shared password viewer and token canary        | Static/API contracts plus live public-artifact spec              | Open P1 wrong-password to pinned-revision browser journey            |

Each suite records the following JSON:

```json
{
  "caseId": "PAIR-08",
  "status": "PASS",
  "startedAt": "ISO-8601",
  "durationMs": 0,
  "browserUrl": "redacted-safe-url",
  "boardId": "public-board-id",
  "expectedRevisionId": "public-revision-id-or-null",
  "observedRevisionId": "public-revision-id-or-null",
  "consoleErrorCount": 0,
  "pageErrorCount": 0,
  "evidence": ["relative-sanitized-path"],
  "cleanup": "PASS"
}
```

On failure, preserve the first error, stop subsequent mutation suites, and run
only read-only diagnosis and safe cleanup.

## 20. Complete protected-operation coverage

All 21 operations below must complete at least one successful path for a full
product PASS.

```text
board_list
board_connection_status
board_get
board_create
board_archive
board_capabilities_get
board_scene_get
board_scene_replace
board_scene_patch
board_scene_clear
board_artifact_get
board_artifact_put
board_artifact_stop
board_history_list
board_history_get
board_history_restore
board_interaction_request
board_interaction_status
board_interaction_respond
board_pair_request
board_pair_status
```

In an environment without MCP, run the same coverage separately through the
official API fallback. Never switch to fallback after an MCP call fails due to
authentication, authorization, conflict, or server error.

## 21. Completion report

The final report must include:

- target URL, browser version, viewport, and run ID;
- PASS/FAIL/BLOCKED/NOT RUN counts;
- exact board ID created or selected by pairing;
- whether any prior-board contamination occurred;
- terminal state and response delivery for every HITL type;
- immutable-ready and browser-active state for every artifact;
- revision creation, history navigation, and restoration outcomes;
- console, page, and request error summary;
- security-leak scan result;
- cleanup result; and
- the first reproducible failure plus its post-fix rerun result.

Grant a full PASS only when the app remains healthy after every case and no user
data outside the dedicated QA data was changed.
