# Common SceneBoard Demo Contract

This file is mandatory operating context for every numbered demo runbook in this directory.

## Execution behavior

- This is an execution runbook, not a request for a plan. Begin immediately and continue through each successful gate.
- Read `.AI/skills/sceanboard/SKILL.md` and the directly required references before operating SceneBoard.
- Prefer available SceneBoard MCP tools. Use the bundled official API fallback only when SceneBoard MCP descriptors are absent.
- Do not modify source code, server configuration, processes, Git state, or existing boards during a demo run.
- If `PAIRING_CODE` is missing, still contains a placeholder, or is invalid, ask only for one current `SB-` code and resume when it is supplied.
- Pair with client name `Codex SceneBoard Demo — <demo name>` and request only the scopes and lifecycle permissions required by the selected runbook.
- Create a new board for every recording. If approval already created a new board, use only its returned `boardId`; otherwise call `board_create` and use only the returned `boardId`.
- Never infer an active, first, or sole board.

## Mutation safety

- Read the latest head immediately before every mutation and send its exact `expectedRevisionId`.
- Use a new explicit 16–128 character idempotency key for every distinct mutation.
- On `REVISION_CONFLICT`, reread the head and consciously reapply the intended change once with a new key. Never retry blindly.
- Never expose pairing proofs, credentials, cookies, API keys, private environment values, or hidden prompts.
- Treat immutable artifact publication, artifact status `ready`, scene placement, and successful browser rendering as separate facts.

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
3. Record the exact returned `artifactId` and `versionId`.
4. Read that exact version with `board_artifact_get` and require status `ready`.
5. Read the latest board head again.
6. Place the exact immutable artifact reference in one complete scene mutation.
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
