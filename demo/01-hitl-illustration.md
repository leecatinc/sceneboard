# Demo 01 — Human-Guided 2D Illustration

PAIRING_CODE: `{{SB_CODE}}`

Read `demo/_COMMON.md` and follow it as mandatory operating policy. Then execute this runbook immediately.

## Goal

Demonstrate that Codex does the creative work while a meaningful human choice controls the result. Build the artwork progressively so the recording captures both AI action and human authority.

## Connection and board

Request `board.read`, `board.write`, `board.history.read`, `board.hitl.request`, and `artifact.publish`, plus lifecycle `board.create`. Create a new board titled:

`SceneBoard Demo — Human-Guided Illustration`

## Opening scene

Publish a native opening scene containing:

- `AI Builds the Visual. A Human Directs the Story.`
- `Codex will sketch a scene, but a person chooses the world it belongs to.`
- Three stages: `Choose a setting` → `Watch the outline appear` → `Approve color`
- Status: `Waiting for one creative decision.`

## Decision 1 — setting

Create one `choice` interaction:

Use the real SceneBoard interaction command and require the resulting choice card to appear in the automatic decision tray or as an inline `content.hitl` node before waiting.

- Question: `Where should the cat play?`
- Explanation: `Your choice determines the environment in both the monochrome outline and the colored result. It does not change account data or permissions.`
- Options:
  - `A sunny garden` — sun, tree, flowers, and butterflies.
  - `A star-filled space adventure` — moon, planet, stars, and a paper rocket.
  - `A rainy city` — buildings, umbrella, raindrops, and puddles.

Wait for the authoritative answer. Do not continue without it.

## Outline artifact

Create a self-contained 1200×675 Canvas or SVG artifact titled `The Cat Codex Drew` with the subtitle `Built live by Codex, guided by your choice: <actual choice>.`

Draw for 6–8 seconds as though a child were sketching with a black crayon:

1. A moving pencil tip draws the cat's head and uneven triangular ears.
2. Large outlined eyes, a smiling face, body, paws, and curled tail appear.
3. The selected environment is added one imperfect outlined element at a time.
4. Hold the finished monochrome result with `Outline complete.`

Do not use fill colors, gradients, or colored accents. Preserve the completed outline as its own immutable artifact and board revision.

## Decision 2 — color

Create one `confirmation` interaction:

Use the real SceneBoard interaction command and require the resulting confirmation card to appear before waiting.

- Title: `Should Codex add color now?`
- Body: `The outline is safely preserved in revision history. Approving will create a new colored version without replacing the recorded outline.`
- Confirm: `Yes, add color`
- Cancel: `No, keep the outline`

If the answer is no, keep the outline as final and stop successfully. If yes, continue.

## Colored artifact

Publish a new immutable version that preserves the exact composition and gradually fills it over 5–7 seconds:

- Cat: warm orange and cream, green eyes, pink cheeks.
- Garden: pale blue sky, yellow sun, green tree, red apples, colorful flowers.
- Space: deep navy field, gold stars, violet planet, silver moon, red paper rocket.
- City: blue-gray sky, colorful windows, yellow umbrella, reflective puddles.

Keep the black outline visible. End with `Color complete — one human choice shaped the whole picture.` Hold the result for at least six seconds.

## Recording close

Verify history contains both the outline and colored revisions. If browser control is available, show `Previous` for the outline and `Latest` for the colored result. End on:

`Codex creates. A person decides. SceneBoard preserves both.`
