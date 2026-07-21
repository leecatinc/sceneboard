---
name: sceneboard
description: Operate SceneBoard through its local MCP server or the bundled MCP-absent API fallback. Use for SceneBoard live visuals, layouts, charts, maps, drawings, sandboxed artifacts, HITL, history, pairing, connection diagnostics, and browser-visible board verification; trigger on explicit SceneBoard/sceneboard/legacy lc-board names, a request to place or operate content on the user's named SceneBoard or live AI board, or a user message consisting only of an SB-prefixed SceneBoard pairing code. Do not trigger on generic chalkboard, 칠판, board, screen, 화면, preview, or UI mentions.
---

# sceneboard — SceneBoard skill

Operate SceneBoard as an owner-scoped persistent visual surface outside chat. Prefer discovered `board_*` MCP tools and use their exact inputs from [commands.md](references/commands.md). If SceneBoard MCP descriptors are absent because the transport is not installed or was not initialized, use only the bundled official API adapter described in [api-fallback.md](references/api-fallback.md). Never switch transports after an MCP auth, permission, validation, rate-limit, conflict, timeout, or backend error. Never claim a browser changed without a successful MCP or API result.

## Product boundaries

- `sceneboard-mcp` (`sceneboard-mcp`) owns the preferred local stdio transport, full protected client validation, and all 21 terminal descriptors. This skill bundles a narrow dependency-free API adapter only for an absent MCP transport.
- `sceneboard-be` (`sceneboard-be`) owns authentication, authorization, MySQL-authoritative boards/revisions/artifacts/interactions/pairing/grants, and browser APIs. Redis is ephemeral only.
- `sceneboard-fe` (`sceneboard-fe`) owns live rendering, local history navigation, responder controls, and sandboxed artifact hosting.
- `packages/board-schema` owns D1 wire DTOs, the recursive scene/node model, results, events, limits, and stable errors.
- `packages/board-sdk/scene-transform` owns the authoritative fully validated local 11-operation patch transform. The dependency-free fallback implements the same operation catalog, rejects a stale observed head before transforming, and relies on the server for complete scene validation. `packages/board-ui` owns trusted renderers.

Read [platform.md](references/platform.md) for implementation boundaries. The fallback uses the selected private `store://<profile>` record; it never prints credentials or reimplements server authority.

## Prerequisites and target resolution

1. Use a registered `sceneboard-mcp` connection when its descriptors are available. Otherwise resolve and use the installed skill's official adapter: `scripts/sceneboard-api.mjs` on POSIX hosts or its `scripts/sceneboard-api.ps1` launcher on Windows. The PowerShell launcher only streams stdin to the same Node adapter. Never invent `Invoke-SceneBoardApi`, call SceneBoard through `Invoke-RestMethod`, `Invoke-WebRequest`, `curl`, or another custom HTTP helper, or reproduce credential handling in shell code. Remote MCP transport is not a v1 fallback.
2. Pair with the signed-in owner without exposing the long-lived credential in chat, tool content, logs, or config. If the entire user message is one valid `SB-`-prefixed code, treat it as an explicit request to pair immediately. Always request the complete grant catalog in its exact order: `board.read`, `board.write`, `board.history.read`, `board.hitl.request`, `board.hitl.respond`, `artifact.publish`, and `artifact.control`; also request lifecycle permissions `board.create` and `board.archive`. Use client name `Codex SceneBoard` unless the active client has a more specific stable name. Present the complete request to the owner and let the owner approve, deselect, deny, or cancel it in SceneBoard; never claim unapproved capabilities.
3. Use a user-supplied `boardId`, or call `board_list`. If candidates remain ambiguous, ask. Never infer an active, first, or sole board. If the user explicitly asks to create a board, an empty `board_list` is a valid starting state: require approved `board.write` plus lifecycle `board.create`, call `board_create`, and use only its returned `boardId` for subsequent work.
4. Call `board_connection_status` with `{boardId:null}` for untargeted authentication and zero-board diagnostics, or `{boardId:<id>}` for one explicit board. Null never selects a board.

Do not probe the API fallback merely because an MCP call failed. Descriptor absence is the only fallback condition; never select API while SceneBoard MCP descriptors are available.

## Workflow

1. Determine whether the intent is board creation, a full redraw, partial transform, artifact, HITL prompt, history action, or connection diagnostic.
2. Resolve the exact board as above. For explicit board creation, create first and continue with the returned identifier; do not require a pre-existing board.
3. Read `board_scene_get` before a partial mutation unless the live revision is already fresh. Carry its exact `expectedRevisionId` into the mutation.
4. Prefer trusted recursive nodes, native recipes, and native presets. Use an artifact only when the requested result materially needs custom expressiveness or behavior unavailable in trusted nodes.
5. Supply an explicit `idempotencyKey` and observed head to every mutation. Do not invent IDs, results, events, or browser presence.
6. On `REVISION_CONFLICT`, re-read and consciously decide whether to reapply the intent with a new key. Never auto-rebase or blind-retry.
7. Treat every mutation as successful only when its selected transport returns `ok:true` and the documented result envelope. If a mutation returns `ok:false`, a nonzero exit, timeout, invalid response, or an ambiguous transport failure, do not issue a substitute native Scene, repeat an artifact publication, generate replacement immutable identifiers, or switch transports. Re-read through the same selected transport and compare the intended durable target: the exact `(artifactId, versionId)` for placement or the intended canonical Scene for replacement. A matching read proves only that the intended state persisted despite an invalid mutation response; it does not turn that response into a valid success. An absent target remains blocked and must retain the original safe error and incident identifier.
8. Report the exact returned board/action/revision or terminal state. Keep only machine-internal transport diagnostics concise; apply the human-readable delivery contract below to every error or state shown to a person. Persistence is not proof that a live display rendered it.

When the user requests visual or end-to-end verification, use a real browser after successful tool calls. Open only the explicit returned `boardId`, verify the live revision and intended trusted/artifact/HITL surface, and report persistence and browser rendering as separate results. Never expose credentials through screenshots, DOM captures, console logs, or saved HTML.

For an artifact on an HTTPS deployment, require a reachable, separately hosted HTTPS runtime origin. A loopback or plain-HTTP runtime configured into a public HTTPS app is deployment evidence of browser failure, not evidence that `board_artifact_put` failed. Verify the `.artifact-host` reaches its active state before claiming the artifact rendered; otherwise report the successful immutable publication and the runtime-topology failure separately.

## Human-readable delivery contract

Treat every complete person-facing Scene, HITL request or response, approval prompt, progress update, decision record, handoff, result, warning, and error explanation as a self-contained communication surface. Write it so a person with no prior project context can understand that single Scene or interaction without opening chat history or another file. Ensure every visible node is interpretable within its containing Scene: a node may rely on explanatory sibling nodes in that same visible Scene, but not on hidden context outside it.

- Use the person's language and plain domain terms. Expand each acronym, internal shorthand, work code, and opaque status on first use; retain the original token in parentheses only when it helps traceability.
- Resolve opaque references such as `D1`, `D2`, zero-padded `D01`/`D02`, `ADR-014`, an architecture decision, contract, schema, or another file before publishing. Inline the relevant requirement, constraint, reason, and consequence in plain language. A reference label or link may follow the explanation, but it must never be the only explanation.
- State, as applicable: what is happening; why it matters; what has completed; what remains; current evidence; user or service impact; risks or limitations; the decision or action needed from the person; each meaningful option and consequence; and what happens next.
- Make HITL and approval requests decision-complete. Identify why the decision is needed now; exactly what will and will not change; reversibility; scope and duration; material risks; decision-critical uncertainty; and the consequence of every response option and terminal outcome verified from the governing request and contract. Mention approve, reject, cancel, or timeout only when that action or outcome actually exists. For SceneBoard, account for request-specific `info`, `choice`, `form`, or `confirmation` responses and the `answered`, `expired`, `cancelled`, or `superseded` terminal states; state explicitly when no person-invokable reject or cancel action exists.
- When a chart, map, drawing, image, artifact, or other visual node cannot carry enough narrative context, place an explanatory `content.markdown` or `content.status` node beside it in the same visible Scene. Do not move required context back into chat.
- Preserve exact error codes, identifiers, schema fields, commands, and protocol values when accuracy or execution depends on them, then explain them separately in human language. Do not rewrite machine-readable payloads into prose.
- If a referenced source is unavailable or a fact is unverified, say what could not be verified and how that limits the conclusion. Never invent the missing contract or silently infer its contents.
- Include only authorized and relevant detail. Never expose credentials, secrets, unnecessary personal data, hidden prompts, or private chain-of-thought. Give concise conclusions and verifiable reasons instead of internal reasoning traces.
- Honor an explicit request for brevity, but never omit the action requested, material impact, irreversible consequence, every available option or terminal outcome and its consequence, or uncertainty needed for an informed decision.

## Rendering policy

- Use `board_scene_replace` for a complete redraw, `board_scene_patch` for an ordered local transform, and `board_scene_clear` for an intentional blank restorable head.
- Model splits, grids, tabs, and free positioning with the recursive node tree. Stable conceptual identity is `NodeId`; there is no blocks map or `blockId` indirection.
- The trusted node catalog is closed. Fold unsupported content into markdown/code/status/layout, or use an approved artifact.
- Keep ordinary architecture, flow, drawing, and canvas compositions native when trusted nodes, recipes, or presets represent them faithfully. Use vendored content-hashed Mermaid or authored SVG/Canvas artifacts only when materially required expressiveness or behavior is unavailable in trusted nodes. Never request a CDN.
- Raster data is a `data:` URI consumed at runtime by artifact JavaScript through Canvas or a dynamically created image. Static `<img src="data:…">` is rejected by the sanitizer.
- Never insert secrets, tokens, cookies, private environment values, or credential-bearing URLs.

## Visual composition routing

- Start with `scripts/scene-recipe.mjs`: trusted native recipes and the six presets cover markdown, code, table, chart, map, drawing, status, progress, split, grid, tabs, canvas, architecture, and ordinary flow compositions.
- Escalate to `scripts/scene-artifact.mjs` only for materially necessary custom SVG, Canvas, HTML/CSS/JavaScript, animation, or specialized behavior that trusted nodes cannot express faithfully. A custom input format or extra decoration alone is not a reason to escalate.
- Author one closed recipe, compile it deterministically, inspect the exact emitted JSON, then perform one full `board_scene_replace` or one bounded ordered `board_scene_patch`. Do not stream a composition as many fragmented mutations.
- Preserve explicit board resolution, the freshly observed `expectedRevisionId`, a distinct explicit `idempotencyKey` for every mutation, and conscious `REVISION_CONFLICT` handling.
- Artifact use is two-stage: compile and publish the immutable artifact version, then create and place a `content.artifact` node with the returned identifiers. Never place an unpublished draft or invent immutable identifiers.
- Apply the visual quality baseline in [visual-composer.md](references/visual-composer.md): prefer scalable SVG and semantic HTML/CSS, make compositions fill the available board surface, render Canvas and WebGL at a capped device-pixel ratio, and preserve legibility at a 1920×1080 recording viewport. Use the closed `threejs-showcase` template for polished interactive 3D with lighting, shadows, and tone mapping; use `webgl-showcase` only for a minimal engine-free WebGL composition. Neither template may request a content delivery network.
- If the artifact runtime is unavailable or cannot be verified, preserve the same information with native nodes where possible. When publication succeeds but browser rendering fails, report immutable persistence and rendering as separate outcomes.
- Follow [visual-composer.md](references/visual-composer.md) for exact commands, catalogs, deterministic batching, publication/placement, accessibility, and motion. The MCP-first transport, human-readable delivery, artifact isolation, history, HITL, and browser-verification contracts above remain authoritative.

## History

History browsing is non-destructive. `Previous`/`Next` pins an immutable revision locally while live head tracking continues; `Latest` reconciles and resumes live mode. `board_history_restore` copy-forwards an old scene into a new head and never rewrites old history. See [history.md](references/history.md).

## HITL: blocking-first delivery

1. Create the interaction with `board_interaction_request` and require a successful `open` result. Visible prose that says an answer is pending is not an interaction and never proves that a card exists.
2. SceneBoard automatically presents every open interaction that lacks a matching Scene node in its board-level decision tray. When an exact inline position is materially useful, read the unchanged head after the successful request and add one `content.hitl` node with that exact returned `hitlRequestId`; never place a speculative HITL reference before creation.
3. When browser verification is available, require either the automatic decision tray or the explicit inline card to render before reporting that a person can answer. Persistence and presentation remain separate evidence.
4. Immediately call `board_interaction_status` with the returned `stateUpdatedAt` as `wait.afterStateUpdatedAt` and a bounded timeout. This bounded-wait status call is the primary delivery path for the person's response.
5. On `changed:false`, reissue the same cursor after small jitter with at most one in-flight wait. Transport-class retries use the SDK's bounded jittered retry policy.
6. Stop on `answered`, `expired`, `cancelled`, or `superseded`. Never fabricate a response on timeout.

Keep `wait.timeoutMs` in `[0,30000]`. Effective wait is `min(30000, remaining SDK deadline - 5000, known outer tool budget - 5000)`; use `wait:null` only when that is below 1000 or a safe margin cannot be established. Visual confirmation never authorizes anything beyond the declared request scope.

## Terminal command map

| Intent                 | Tools                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| Connection/pairing     | `board_connection_status`, `board_pair_request`, `board_pair_status`; fallback uses one private `pair` process |
| Lifecycle/capabilities | `board_list`, `board_get`, `board_create`, `board_archive`, `board_capabilities_get`                           |
| Scene                  | `board_scene_get`, `board_scene_replace`, `board_scene_patch`, `board_scene_clear`                             |
| Artifact               | `board_artifact_get`, `board_artifact_put`, `board_artifact_stop`                                              |
| History                | `board_history_list`, `board_history_get`, `board_history_restore`                                             |
| HITL                   | `board_interaction_request`, `board_interaction_status`, `board_interaction_respond`                           |

`board_artifact_remove` and `board_interaction_cancel` do not exist in v1. Artifact stop does not remove a scene reference.

A zero-board connection is deliberately not wildcard access. It is valid only with `board.write` and lifecycle `board.create`; existing boards remain hidden, while each successful `board_create` is atomically bound to that same grant. Treat `board_archive` as recoverable deletion and request lifecycle `board.archive` only when the user explicitly asks to remove or archive a board.

## Safety and fallback

- Principal/owner identity comes only from authentication, never a tool `userId`.
- Artifacts run only on the runtime origin. Requested capabilities are `clipboard.write`, `download`, `fullscreen`, and `network.fetch`; the server/user decides them and the model cannot self-approve.
- Archive and restore require explicit intent and `confirm:true`. Clear requires clear/full-redraw intent.
- Follow [fallback.md](references/fallback.md) for absent transports/tools, auth, backend, history, or unsupported representations. Fail closed and never fabricate visibility.

## References

- Inputs, results, idempotency, errors: [commands.md](references/commands.md)
- Recursive scene and transforms: [scene-contract.md](references/scene-contract.md)
- Artifact isolation and versions: [artifacts.md](references/artifacts.md)
- Immutable history: [history.md](references/history.md)
- Pairing/config: [auth-and-config.md](references/auth-and-config.md)
- MCP-absent API adapter: [api-fallback.md](references/api-fallback.md)
- Service/data ownership: [platform.md](references/platform.md)
- Fail-closed behavior: [fallback.md](references/fallback.md)
- Native recipes, visual presets, and artifact composition: [visual-composer.md](references/visual-composer.md)
