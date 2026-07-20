# Common SceneBoard Demo Contract

This file is mandatory operating context for every numbered demo runbook in this directory.

## Execution behavior

- This is an execution runbook, not a request for a plan. Begin immediately and continue through each successful gate.
- Read `.AI/skills/sceanboard/SKILL.md` and the directly required references before operating SceneBoard.
- Prefer available SceneBoard MCP tools. Use the bundled official API fallback only when SceneBoard MCP descriptors are absent.
- On Windows API fallback, invoke only the installed `scripts/sceneboard-api.ps1` launcher and pipe JSON through stdin. Never create `Invoke-SceneBoardApi`, use a direct REST helper, decrypt a credential in the shell, or reinterpret the server envelope manually.
- Do not modify source code, server configuration, processes, Git state, or board ownership during a demo run.
- Pair once before the first recording. Every numbered demo must reuse the currently approved SceneBoard connection and the exact board already bound to that credential.
- Never request, consume, or ask for another `SB-` code merely because a new demo file started. If the existing connection is missing, revoked, expired, or bound to no board, stop with one precise prerequisite instead of silently creating another connection.
- Never create, archive, delete, switch, or infer a board during a numbered demo. Confirm the exact reusable `boardId` through `board_connection_status` or the credential's authoritative connection state.

## Shared-board reset before every demo

Run this reset before the numbered runbook's first visible scene:

1. Call `board_connection_status` and require the existing approved credential, exact bound `boardId`, and every capability needed by the selected runbook.
2. Read the current live board snapshot and latest head.
3. If any Human-in-the-Loop interaction remains `open`, do not invent an answer. Continue its bounded wait when it belongs to the current take; otherwise stop and ask the owner to cancel or finish it before retrying the demo.
4. If an artifact runtime is still active and `artifact.control` is available, stop that runtime before clearing the Scene.
5. Call `board_scene_clear` once with the exact latest `expectedRevisionId` and a fresh idempotency key. On a revision conflict, reread and deliberately retry once under the normal mutation rule.
6. Read the head again and require the current live Scene to be empty before publishing the new demo opening.

This reset clears only the current live presentation. Immutable revision history and previously published artifact versions remain available for audit and must not be deleted. Reuse the same board across every demo file.

## Mutation safety

- Read the latest head immediately before every mutation and send its exact `expectedRevisionId`.
- Use a new explicit 16–128 character idempotency key for every distinct mutation.
- On `REVISION_CONFLICT`, reread the head and consciously reapply the intended change once with a new key. Never retry blindly.
- Never expose pairing proofs, credentials, cookies, API keys, private environment values, or hidden prompts.
- Treat immutable artifact publication, artifact status `ready`, scene placement, and successful browser rendering as separate facts.
- A failed, timed-out, or invalid mutation response never authorizes a replacement native Scene or a repeated artifact publication. Read through the same transport and require the exact intended durable target; if absent, stop with the original safe error. If present, report persistence as read-back evidence while keeping the original response failure explicit.

## Recording language and visual quality

- Every terminal message, board title, visible label, Human-in-the-Loop request, option, status, accessibility description, and completion report must be clear natural English.
- Explain every visible screen so a first-time viewer can understand it without chat history or another document.
- Use a recording-friendly 16:9 composition, generous spacing, strong hierarchy, high contrast, and large readable text.
- Use the exact phrase `Built live by Codex` where authorship matters.
- Avoid dense paragraphs, tiny labels, implementation identifiers, fake metrics, and unexplained abbreviations.
- Do not use external CDNs, network requests, fonts, images, scripts, or libraries.
- Publish artifacts with `requestedCapabilities: []` unless a numbered runbook explicitly requires a user-approved capability. None of the current runbooks requires one.
- Honor `prefers-reduced-motion: reduce` by showing the complete static result without losing information.
- Provide an accessible title and a complete text alternative for Canvas, SVG, CSS 3D, and animated surfaces.
- For a full-frame artifact, call `window.SceneBoardArtifact.requestResize(1200, 675)` after the bridge is available and author at a 1200×675 design size.

## Human-in-the-Loop behavior

- Never guess, manufacture, or default a human answer.
- Create the real interaction with `board_interaction_request`; explanatory Markdown such as `Waiting for a decision` is not a Human-in-the-Loop card and is never proof that a request exists.
- Require the request result to be `open`. SceneBoard automatically presents an open interaction in the board-level decision tray when the current Scene has no matching `content.hitl` node.
- When the recording composition needs an exact inline position, read the unchanged Scene head after the successful request and add one `content.hitl` node using that exact returned `hitlRequestId`. Never place a speculative ID before the interaction exists.
- When browser verification is available, require either the automatic decision tray or the explicit inline card to be visible before claiming that the person can answer.
- After presentation is established, immediately wait through `board_interaction_status` using the returned `stateUpdatedAt` cursor and bounded waits of at most 30 seconds.
- Keep at most one wait in flight. Continue bounded waits while the interaction is `open`.
- Stop on `answered`, `expired`, `cancelled`, or `superseded` and explain the exact outcome in plain English.
- A Human-in-the-Loop card must state why the decision is needed, what each choice changes, what remains unchanged, and what happens next.

## Artifact publication sequence

1. Read the current board head.
2. Publish one immutable artifact with `board_artifact_put`, `artifactId:null`, a fresh idempotency key, and `requestedCapabilities:[]`.
3. Record the exact returned `artifactId` and `versionId`. In official API fallback output the path is `$.result.result.artifact.artifact.{artifactId,versionId}`; never guess a shallower result path.
4. Read that exact version with `board_artifact_get` and require status `ready`.
5. Read the latest board head again.
6. Place the exact immutable artifact reference in one complete scene mutation.
   If placement returns an invalid or ambiguous response, read the live Scene through the same transport. Continue only if that read contains this exact `(artifactId, versionId)`; otherwise stop. Never substitute native content merely to keep the recording moving.
7. When browser verification is available in the current approved session, verify the real board and `.artifact-host.artifact-active`. Do not create another browser profile or expose session material.

## Completion evidence

End each run with only:

```text
SceneBoard demo ready
- Demo: <name>
- Board: <title and actual URL or boardId>
- Human decisions: <actual answers or none>
- Final revision: <display number or revision ID>
- Artifact ready: <yes|no|not-used>
- Browser active: <yes|no|not-checked>
- Recording status: <READY | BLOCKED: one specific reason>
```

Use `READY` only when every required operation and verification in the selected runbook succeeded.
