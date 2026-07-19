# SceneBoard Three-Minute Demo — Codex CLI Runbook

## How to use this file

1. Replace `{{SB_CODE}}` below with a newly issued SceneBoard pairing code.
2. Set the SceneBoard user language to **English** before recording.
3. Paste this entire file into Codex CLI and press Enter.
4. Do not enter anything else in the terminal.
5. In the browser, approve the connection request and make the single human choice when it appears.

For a non-interactive launch, prepend the newest valid pairing code:

```bash
{ printf 'PAIRING_CODE: %s\n' 'SB-XXXXXX-XXXXXX'; cat DEMO.md; } | codex exec -C /workspace/lc/leecat-board -
```

---

# Instructions for Codex

PAIRING_CODE: `{{SB_CODE}}`

You are the presentation agent for a three-minute SceneBoard demo. This is an execution runbook, not background material. Start immediately, continue through every successful gate, and do not stop after describing a plan.

## 0. Language and human-control requirements

Every terminal message and every visible SceneBoard title, scene, Human-in-the-Loop request, option, status, artifact label, accessibility description, and completion report must use clear, natural English. Never show Korean or mixed-language copy during the recorded demo. Before publishing, scan every visible string in the generated HTML, CSS, Canvas labels, and accessibility text; replace any Korean text with natural English.

The artwork must clearly credit Codex as its creator. Never use first-person viewer copy such as `My Cat`, `The Cat I Drew`, or any equivalent phrase. Use the exact artwork title `The Cat Codex Drew` and make it unmistakable that Codex is drawing the picture live.

Complete this flow in one new SceneBoard board:

1. Connect SceneBoard.
2. Ask a person to choose the visual setting.
3. Turn that choice into a childlike 2D Canvas animation.
4. Transform the same scene into a CSS 3D paper-diorama animation.
5. Use revision history to demonstrate movement between the 2D and 3D results.

Human intervention is allowed at exactly two points:

- Approving the connection request in the browser.
- Selecting one option in the Human-in-the-Loop card.

Never guess or manufacture a human response. Do not ask additional terminal questions. The only exception is an absent, placeholder, or invalid `PAIRING_CODE`; in that case, request one valid `SB-` code and resume immediately after receiving it.

## 1. Non-negotiable operating rules

- Read `.AI/skills/sceanboard/SKILL.md` and its directly required references first, then follow them exactly.
- Use SceneBoard MCP tools when they are available. Use the official API fallback only when SceneBoard MCP tools are not available at all. Do not switch transports merely because an MCP call returns an error.
- Do not modify source code, server configuration, builds, processes, or Git state during this run.
- Never modify an existing board or prior demo result. Create a new board for every run.
- Use the exact `boardId` returned by the API. Never infer the first or only board.
- Read the latest head immediately before every mutation and use its exact `expectedRevisionId`.
- Use a unique 16–128 character idempotency key for every mutation. Reuse a key only when retransmitting the identical request.
- On `REVISION_CONFLICT`, read the latest head, reconfirm the intended change, and deliberately reapply it once with a new key. Never retry blindly or indefinitely.
- Write titles, questions, choices, and results in complete human language so a first-time viewer understands the screen without external context.
- Never place secrets, credentials, pairing proof, or API keys on the board or inside an artifact.
- Do not use external CDNs, fonts, images, libraries, or network requests.
- Publish artifacts with `requestedCapabilities: []`. Do not request clipboard, download, fullscreen, or network capabilities.
- Treat artifact status `ready` and successful browser rendering as separate claims requiring separate evidence.
- Never report an unsuccessful or unchecked step as successful.

## 2. Connect and create a board

### 2.1 Pairing request

Use `PAIRING_CODE` to request a connection with this client name:

`Codex SceneBoard Visual Demo`

Request only the current contract scopes required for:

- Reading and writing a board.
- Creating a board.
- Reading revision history.
- Creating and reading a Human-in-the-Loop request.
- Publishing an artifact.

Do not request Human-in-the-Loop response, board archive/delete, artifact control, or any other capability that this demo does not need.

Poll pairing status with bounded waits. On approval, use only the exact board information returned by the approval result. On rejection, cancellation, expiration, or invalid code, print one clear English reason and stop safely.

### 2.2 New board

If approval created a board and returned its exact `boardId`, use it. If pairing succeeded without a board, use `board.create` to create:

`SceneBoard Demo — Human-Guided AI Art`

When ready, print only:

`Connected — a human choice will now shape the artwork.`

## 3. Opening scene

Read the latest head and create the complete opening scene in one scene replacement. Do not stream fragments through multiple mutations.

Show:

- Title: `AI Builds the Visual. A Human Directs the Story.`
- Description: `Codex carries out the work while SceneBoard asks a person to decide the creative direction that matters.`
- Steps: `1. Choose a setting` → `2. Watch Codex draw` → `3. Enter the 3D scene`
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

`Decision received — I will turn the sunny garden into an animated 2D drawing.`

## 5. Childlike 2D Canvas animation

Create one self-contained artifact that exactly reflects the selected option. Codex must visibly draw the picture live, using the warm and imperfect style of an elementary-school child's paint-app drawing and completing it one element at a time.

### Visual contract

- Use a responsive 16:9 Canvas with a 1200×675 design coordinate system.
- Use slightly uneven crayon and marker lines with intentionally imperfect hand-drawn shapes.
- Draw a black cat outline in the center, then fill it with orange and cream colors.
- Give the cat large green eyes, triangular ears, a smiling mouth, and a long waving tail.
- Show the exact handwritten-style title `The Cat Codex Drew` and the subtitle `Drawn live by Codex, guided by your choice.` together with the human's exact choice.
- Run for about 8–10 seconds, then hold the finished image.
- Do not make motion the only way information is conveyed.
- Under `prefers-reduced-motion: reduce`, show the completed picture immediately without animation.
- Provide a complete text alternative for environments without Canvas.
- Keep all CSS and JavaScript inside the artifact and make no network requests.

### Animation sequence

1. 0–2 seconds: show a moving pen or crayon tip while Codex draws the cat outline like a pencil sketch.
2. 2–4 seconds: add the body colors, eyes, cheeks, and tail.
3. 4–7 seconds: draw the selected setting one element at a time.
4. 7–10 seconds: add subtle motion and sparkle, then reveal `Finished — drawn by Codex.`

### Setting details

- `A sunny garden`: a yellow sun in the upper right, an apple tree on the right, grass, flowers, and butterflies. Let sunlight sparkle softly while leaves and the tail sway.
- `A star-filled space adventure`: a navy sky, stars, crescent moon, ringed planet, and tiny paper rocket. Let stars appear in sequence while the cat floats gently.
- `A rainy city`: a blue-gray sky, uneven buildings, a yellow umbrella, and puddles. Animate raindrops and small ripples.

### Publish, place, and verify

1. Read the latest head.
2. Publish a new immutable artifact with `board_artifact_put`, a null new-artifact `artifactId`, and `requestedCapabilities: []`.
3. Record the exact returned `artifactId` and `versionId`.
4. Read that immutable version with `board_artifact_get` and verify status `ready`.
5. Read the latest head again.
6. Place the returned artifact/version reference over the full scene in one mutation.
7. Record the resulting 2D revision ID and display number.

When a browser verifier can reuse the current approved user session, verify `.artifact-host.artifact-active` and the completed image on the real board page. Do not create another browser profile or login. If browser verification is unavailable, state `Browser rendering requires manual verification.` Do not equate publish success with render success. Stop before 3D if the artifact is not `ready` or cannot render safely on the current environment.

After a confirmed render, hold the finished 2D image for about 10 seconds for recording.

## 6. CSS 3D paper-diorama animation

Preserve the selected story and visual elements, but transform the next revision into a layered paper theater made from the picture Codex drew. This is a 3D expression of the same choice, not a new story.

### Implementation contract

- Use only HTML, CSS, and JavaScript; do not use WebGL, Three.js, or external libraries.
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

## 7. Revision time-travel verification

Read `board_history_list` newest first and verify:

- The 2D Canvas revision remains in history.
- A later 3D diorama revision remains in history.
- The two revisions reference different immutable artifact versions.
- The current head is the 3D scene.

Do not call `board_history_restore`. SceneBoard's `Previous`, `Next`, and `Latest` controls must remain local viewing controls that do not change board head.

If the same logged-in browser session can be controlled:

1. Select `Previous` and show the 2D revision for about five seconds.
2. Select `Latest` and return to the 3D revision for about five seconds.
3. Confirm that no page or artifact-runtime error occurred.

If browser control is unavailable, keep the 3D scene visible and print only:

`Recording cue — select Previous in the status rail to show the 2D revision, then Latest to return to the 3D scene.`

## 8. Completion report

Print only this concise evidence report:

```text
SceneBoard demo ready
- Board: <title and actual URL or boardId>
- Human decision: <actual selected result>
- 2D: revision <display number or ID> / artifact ready <yes|no> / browser active <yes|no|not-checked>
- 3D: revision <display number or ID> / artifact ready <yes|no> / browser active <yes|no|not-checked>
- Revision navigation: <verified automatically | presenter click required>
- Recording status: <READY | BLOCKED: one specific reason>
```

Use `READY` only when pairing, the real human answer, both artifact publications, history verification, and all required browser-render checks succeeded. Otherwise use `BLOCKED` and stop at the nearest actionable recovery point.

## 9. Suggested three-minute recording timeline

- 0:00–0:20 — Paste this runbook with an `SB-` code into Codex CLI and connect.
- 0:20–0:45 — Approve in the browser and arrive at the new board automatically.
- 0:45–1:10 — Make one Human-in-the-Loop choice inside SceneBoard.
- 1:10–1:40 — Watch the cat's 2D Canvas drawing form step by step.
- 1:40–2:10 — Transform the same choice into the CSS 3D paper diorama.
- 2:10–2:35 — Compare the 2D and 3D revisions with `Previous` and `Latest`.
- 2:35–2:50 — Hold the final scene and core message.

Final message:

`Make AI work visible, keep meaningful decisions human, and preserve every change — SceneBoard.`
