# SceneBoard Three-Minute Demo — Codex CLI Runbook

## How to use this file

1. Complete one SceneBoard pairing and open its bound board before recording.
2. Set the SceneBoard user language to **English** before recording.
3. Paste this entire file into Codex CLI and press Enter.
4. Do not enter anything else in the terminal.
5. In the browser, answer the three Human-in-the-Loop decisions when they appear.

For a non-interactive launch after the one-time pairing:

```bash
codex exec -C /workspace/lc/leecat-board - < DEMO.md
```

---

# Instructions for Codex

You are the presentation agent for a three-minute SceneBoard demo. This is an execution runbook, not background material. Start immediately, continue through every successful gate, and do not stop after describing a plan.

## 0. Language and human-control requirements

Every terminal message and every visible SceneBoard title, scene, Human-in-the-Loop request, option, status, artifact label, accessibility description, and completion report must use clear, natural English. Never show Korean or mixed-language copy during the recorded demo. Before publishing, scan every visible string in the generated HTML, CSS, Canvas labels, and accessibility text; replace any Korean text with natural English.

The artwork must clearly credit Codex as its creator. Never use first-person viewer copy such as `My Cat`, `The Cat I Drew`, or any equivalent phrase. Use the exact artwork title `The Cat Codex Drew` and make it unmistakable that Codex is drawing the picture live.

Complete this flow on the currently paired shared SceneBoard board:

1. Reuse the approved connection and clear the current live Scene.
2. Ask a person to choose the visual setting.
3. Draw only a childlike monochrome outline of the chosen scene.
4. Ask whether Codex should color the drawing; color it only after an explicit yes.
5. Ask whether Codex should transform the colored drawing into 3D; continue only after an explicit yes.
6. Transform the same scene into a CSS 3D paper-diorama animation.
7. Use revision history to demonstrate movement among the outline, colored 2D, and 3D results.

Human intervention is allowed at exactly three points during this run:

- Selecting the visual setting in the first Human-in-the-Loop card.
- Confirming whether Codex should add color in the second Human-in-the-Loop card.
- Confirming whether Codex should enter the 3D stage in the third Human-in-the-Loop card.

Never guess or manufacture a human response. Do not ask additional terminal questions. If no existing approved connection and exact bound board are available, stop with `BLOCKED: complete the one-time SceneBoard pairing before this demo.` Do not request or consume a new code inside this runbook.

## 1. Non-negotiable operating rules

- Read `.AI/skills/sceanboard/SKILL.md` and its directly required references first, then follow them exactly.
- Use SceneBoard MCP tools when they are available. Use the official API fallback only when SceneBoard MCP tools are not available at all. Do not switch transports merely because an MCP call returns an error.
- Do not modify source code, server configuration, builds, processes, or Git state during this run.
- Reuse only the exact `boardId` bound to the existing approved credential. Never infer the first or only board.
- Never create, archive, delete, rename, or switch boards during this run. Clear only the current live Scene before beginning; immutable prior revisions remain in history.
- Read the latest head immediately before every mutation and use its exact `expectedRevisionId`.
- Use a unique 16–128 character idempotency key for every mutation. Reuse a key only when retransmitting the identical request.
- On `REVISION_CONFLICT`, read the latest head, reconfirm the intended change, and deliberately reapply it once with a new key. Never retry blindly or indefinitely.
- Write titles, questions, choices, and results in complete human language so a first-time viewer understands the screen without external context.
- Never place secrets, credentials, pairing proof, or API keys on the board or inside an artifact.
- Do not use external CDNs, fonts, images, libraries, or network requests.
- Publish artifacts with `requestedCapabilities: []`. Do not request clipboard, download, fullscreen, or network capabilities.
- Treat artifact status `ready` and successful browser rendering as separate claims requiring separate evidence.
- Never report an unsuccessful or unchecked step as successful.

## 2. Reuse and reset the shared board

1. Call `board_connection_status` and require an existing approved credential, its exact bound `boardId`, and the capabilities needed for board read/write, history, Human-in-the-Loop request/status, artifact publication, and artifact control.
2. Read the current live snapshot and latest head.
3. If an earlier Human-in-the-Loop request is still `open`, never manufacture an answer. Stop and require the owner to finish or cancel it before restarting this run.
4. Stop any active artifact runtime.
5. Call `board_scene_clear` with the exact latest `expectedRevisionId` and a fresh idempotency key.
6. Read the head again and require an empty live Scene. Do not delete immutable history or published artifact versions.

When ready, print only:

`Connected — the shared board is clear and a human choice will now shape the artwork.`

## 3. Opening scene

Read the latest head and create the complete opening scene in one scene replacement. Do not stream fragments through multiple mutations.

Show:

- Title: `AI Builds the Visual. A Human Directs the Story.`
- Description: `Codex carries out the work while SceneBoard asks a person to decide the creative direction that matters.`
- Steps: `1. Choose a setting` → `2. Watch Codex sketch` → `3. Approve color` → `4. Approve 3D`
- Status: `A decision request will appear here in a moment.`

Use generous spacing and recording-friendly type. Do not expose implementation terms or identifiers.

## 4. Human-in-the-Loop decision

Read the latest head again and open exactly one `choice` interaction with a unique `hitlRequestId`.

Question:

`Where should the cat play in the finished picture?`

Description:

`Your choice will guide both the 2D animation and the 3D scene. It changes only the visual setting and does not affect your account or data.`

Options:

1. `A sunny garden` — a bright sky, sun, tree, flowers, and butterflies appear.
2. `A star-filled space adventure` — stars, a planet, moon, and tiny rocket appear.
3. `A rainy city` — clouds, raindrops, puddles, buildings, and an umbrella appear.

If the contract does not automatically place the choice on the board, place the exact returned Human-in-the-Loop request reference into the current scene once.

Begin status reads from the returned `stateUpdatedAt`. Keep each wait at or below 30 seconds and repeat bounded waits while the request is `open`. During the wait, print no more than once every 30 seconds:

`Waiting for a human decision… Please choose one setting in SceneBoard.`

Stop waiting immediately on `answered`, `expired`, `cancelled`, or `superseded`. If the state is not `answered`, print the reason and stop. Never substitute a default choice.

After a real answer, print one human-readable line such as:

`Decision received — I will sketch the sunny garden as a monochrome 2D outline.`

## 5. Childlike 2D outline Canvas animation

Create one self-contained artifact that exactly reflects the selected option. Codex must visibly sketch the complete picture live, using the warm and imperfect style of an elementary-school child's pencil drawing. This stage is outline-only: do not add fill colors, colored accents, gradients, or colored backgrounds.

### Visual contract

- Use a responsive 16:9 Canvas with a 1200×675 design coordinate system.
- Immediately call `window.SceneBoardArtifact.requestResize(1200, 675)` after the artifact bridge is available. Do not rely on automatic content-size measurement for full-scene artifacts.
- Use slightly uneven graphite and black crayon lines with intentionally imperfect hand-drawn shapes.
- Draw a black cat outline in the center and leave the body, eyes, cheeks, tail, and environmental elements unfilled.
- Give the cat large outlined eyes, triangular ears, a smiling mouth, and a long outlined tail.
- Show the exact handwritten-style title `The Cat Codex Drew` and the subtitle `Drawn live by Codex, guided by your choice.` together with the human's exact choice.
- Run for about 6–8 seconds, then hold the finished monochrome sketch.
- Do not make motion the only way information is conveyed.
- Under `prefers-reduced-motion: reduce`, show the completed picture immediately without animation.
- Provide a complete text alternative for environments without Canvas.
- Keep all CSS and JavaScript inside the artifact and make no network requests.

### Animation sequence

1. 0–2 seconds: show a moving pencil tip while Codex draws the cat's head and ears.
2. 2–4 seconds: add the outlined eyes, face, body, paws, and tail without filling them.
3. 4–7 seconds: sketch the selected setting one outlined element at a time.
4. At completion, reveal `Outline complete — waiting for your color decision.` and keep every shape monochrome.

### Setting details

- `A sunny garden`: outline the sun in the upper right, an apple tree on the right, grass, flowers, and butterflies without color fills.
- `A star-filled space adventure`: outline stars, a crescent moon, a ringed planet, and a tiny paper rocket without a colored sky.
- `A rainy city`: outline clouds, uneven buildings, an umbrella, raindrops, and puddles without color fills.

### Publish, place, and verify

1. Read the latest head.
2. Publish a new immutable artifact with `board_artifact_put`, a null new-artifact `artifactId`, and `requestedCapabilities: []`.
3. Record the exact returned `artifactId` and `versionId`.
4. Read that immutable version with `board_artifact_get` and verify status `ready`.
5. Read the latest head again.
6. Place the returned artifact/version reference over the full scene in one mutation.
7. Record the resulting outline revision ID and display number.

When a browser verifier can reuse the current approved user session, verify `.artifact-host.artifact-active` and the completed image on the real board page. Do not create another browser profile or login. If browser verification is unavailable, state `Browser rendering requires manual verification.` Do not equate publish success with render success. Stop before the color decision if the outline artifact is not `ready` or cannot render safely on the current environment.

After a confirmed render, hold the finished outline for about six seconds for recording.

## 6. Human-in-the-Loop color confirmation

Read the latest head and open one `confirmation` interaction with a new unique `hitlRequestId`.

- Title: `Should Codex color this drawing now?`
- Body: `The monochrome outline is complete. Choosing yes will preserve this outline in revision history and create a new colored 2D version using the setting you selected. Choosing no will keep the current outline unchanged and end the visual transformation.`
- Impact: `standard`
- Confirm label: `Yes, add color`
- Cancel label: `No, keep the outline`

Place the exact returned Human-in-the-Loop request reference into the current visible scene when the contract does not place it automatically. Continue bounded status waits while the request is `open`; do not end the Codex turn between waits. Stop only on `answered`, `expired`, `cancelled`, or `superseded`.

If the person selects `No, keep the outline`, preserve the outline as the current head, print `Color was not approved — the outline remains unchanged.`, and stop safely. Never infer yes from silence, elapsed time, or visual observation.

## 7. Colored 2D Canvas animation

Continue only after the authoritative response confirms `Yes, add color`.

Create a new immutable artifact that preserves the exact geometry and selected setting from the outline revision, then visibly adds color without redrawing a different composition.

- Call `window.SceneBoardArtifact.requestResize(1200, 675)` and retain the 1200×675 16:9 design coordinate system.
- Keep the original black outline visible throughout the transition.
- Fill the cat with orange and cream, give it large green eyes and warm cheeks, and color the selected setting one element at a time.
- Animate the coloring for about 5–7 seconds as if Codex were using a child's paint tool, then reveal `Color complete — guided by your decision.`
- Honor `prefers-reduced-motion: reduce` by showing the completed colored image immediately.
- Keep the title `The Cat Codex Drew`, the human's exact setting choice, and a complete text alternative visible or accessible.

Read the latest head, publish the immutable artifact, verify its exact version is `ready`, reread the latest head, and replace the outline artifact with the colored artifact in one mutation. Record the colored 2D revision ID and display number. After confirmed browser rendering, hold the colored result for about six seconds.

## 8. Human-in-the-Loop 3D confirmation

Read the latest head and open one `confirmation` interaction with a new unique `hitlRequestId`.

- Title: `Should Codex bring this picture into 3D?`
- Body: `The colored 2D drawing is complete. Choosing yes will preserve it in revision history and create a new interactive paper-diorama revision using the same cat and setting. Choosing no will keep the colored 2D picture as the final result.`
- Impact: `standard`
- Confirm label: `Yes, enter 3D`
- Cancel label: `No, stay in 2D`

Place the exact request reference in the visible scene when needed and keep the Codex turn active through repeated bounded status waits. If the person selects `No, stay in 2D`, preserve the colored 2D scene, print `3D was not approved — the colored 2D drawing remains the final scene.`, and stop safely.

## 9. CSS 3D paper-diorama animation

Preserve the selected story and visual elements, but transform the next revision into a layered paper theater made from the picture Codex drew. This is a 3D expression of the same choice, not a new story.

### Implementation contract

- Use only HTML, CSS, and JavaScript; do not use WebGL, Three.js, or external libraries.
- Call `window.SceneBoardArtifact.requestResize(1200, 675)` and author the complete stage at that 16:9 design size.
- Create a perspective stage with background, middle, and foreground layers.
- Use `transform-style: preserve-3d` and distinct `translateZ` values.
- Place the cat in the foreground, the main environmental elements in the middle, and the sky/distant scenery in the background.
- Allow subtle pointer-driven tilt within a safe range to reveal depth.
- Without pointer input, animate gentle breathing, tail movement, and environmental motion.
- Avoid excessive rotation, flashing, and fast camera movement.
- Under `prefers-reduced-motion: reduce`, disable motion and parallax and show the completed front view.
- Include an accessible title and a detailed English description of the selected result.
- Make no network request and request no additional capability.

Layer mapping:

- Garden: sky and sunlight / tree and flowers / cat and butterflies.
- Space: stars and nebula / planet and moon / cat and paper rocket.
- City: clouds and buildings / rain and streetlight / cat, umbrella, and puddle.

Follow the same safe sequence as the 2D artifact: read head, publish immutable artifact, reread the exact version and confirm `ready`, reread head, replace the 2D artifact with the 3D artifact in one mutation, record the revision, and verify `.artifact-host.artifact-active` in the same approved browser session when possible.

After a confirmed render, hold the 3D scene for about 10 seconds.

## 10. Revision time-travel verification

Read `board_history_list` newest first and verify:

- The monochrome outline revision remains in history.
- A later colored 2D Canvas revision remains in history.
- A later 3D diorama revision remains in history.
- The three visual revisions reference the intended immutable artifact versions.
- The current head is the 3D scene.

Do not call `board_history_restore`. SceneBoard's `Previous`, `Next`, and `Latest` controls must remain local viewing controls that do not change board head.

If the same logged-in browser session can be controlled:

1. Select `Previous` until the recorded colored 2D artifact revision is visible, then hold it for about five seconds.
2. Continue selecting `Previous` until the recorded monochrome outline artifact revision is visible, then hold it for about five seconds. Human-in-the-Loop card revisions may appear between the visual artifact revisions.
3. Select `Latest` and return to the 3D revision for about five seconds.
4. Confirm that no page or artifact-runtime error occurred.

If browser control is unavailable, keep the 3D scene visible and print only:

`Recording cue — use Previous to reach the recorded colored 2D revision, continue to the recorded outline revision, then select Latest to return to the 3D scene.`

## 11. Completion report

Print only this concise evidence report:

```text
SceneBoard demo ready
- Board: <title and actual URL or boardId>
- Setting decision: <actual selected result>
- Color decision: <actual yes|no result>
- 3D decision: <actual yes|no result>
- Outline: revision <display number or ID> / artifact ready <yes|no> / browser active <yes|no|not-checked>
- Colored 2D: revision <display number or ID> / artifact ready <yes|no> / browser active <yes|no|not-checked>
- 3D: revision <display number or ID> / artifact ready <yes|no> / browser active <yes|no|not-checked>
- Revision navigation: <verified automatically | presenter click required>
- Recording status: <READY | BLOCKED: one specific reason>
```

Use `READY` only when connection reuse, shared-board reset, all three real human answers, all three artifact publications, history verification, and all required browser-render checks succeeded. Otherwise use `BLOCKED` and stop at the nearest actionable recovery point.

## 12. Suggested three-minute recording timeline

- 0:00–0:15 — Paste this runbook into Codex CLI and reuse the approved SceneBoard connection.
- 0:15–0:35 — Clear the current live Scene and show the opening message on the same board.
- 0:45–1:00 — Choose the setting in the first Human-in-the-Loop card.
- 1:00–1:20 — Watch Codex draw the monochrome outline.
- 1:20–1:35 — Approve color, then watch the 2D fills appear.
- 1:35–1:50 — Approve the 3D transition.
- 1:50–2:15 — Watch the colored drawing become a CSS 3D paper diorama.
- 2:15–2:40 — Compare the outline, colored 2D, and 3D revisions with `Previous` and `Latest`.
- 2:40–2:50 — Hold the final scene and core message.

Final message:

`Make AI work visible, keep meaningful decisions human, and preserve every change — SceneBoard.`
