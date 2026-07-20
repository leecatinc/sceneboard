# Demo 02 — Interactive 3D Paper Diorama

Read `demo/_COMMON.md` and follow it as mandatory operating policy. Then execute this runbook immediately.

## Goal

Turn one human-selected setting into an interactive 3D paper theater using only local HTML, CSS, and JavaScript. The finished scene must visibly respond to pointer movement without requiring WebGL or an external library.

## Shared board

Reuse the approved connection and exact shared board required by `_COMMON.md`. Complete the mandatory shared-board reset, then begin this take on the empty live Scene. Do not pair again or create another board. Use `SceneBoard Demo — Interactive 3D World` as the visible demo heading.

## Human choice

Create one `choice` interaction:

Use the real SceneBoard interaction command and require the resulting choice card to appear in the automatic decision tray or as an inline `content.hitl` node before waiting.

- Question: `Which world should Codex build in 3D?`
- Explanation: `This controls the visual theme only. Codex will build the selected world as a layered paper diorama.`
- Options:
  - `Garden at golden hour`
  - `Deep-space observatory`
  - `Rainy neon street`

Wait for the real answer.

## 3D artifact

Build one 1200×675 artifact with:

- A perspective stage using `perspective`, `transform-style: preserve-3d`, and distinct `translateZ` layers.
- At least five depth layers: distant atmosphere, background, middle scenery, foreground character, and floating particles.
- A stylized paper cat in the foreground with gentle breathing, blinking, and tail motion.
- Pointer-driven tilt limited to a comfortable range; reset smoothly when the pointer leaves.
- Soft layered shadows that make the paper cutouts visibly separate.
- A visible title: `A World Built Live by Codex`.
- A small instruction: `Move the pointer to explore the depth.`
- A theme-specific ambient animation:
  - Garden: drifting petals, moving sunlight, butterflies.
  - Space: slow star parallax, orbiting paper planet, floating rocket.
  - City: falling rain, reflected neon, umbrella movement.

Do not use WebGL, Three.js, network access, or device sensors. In reduced-motion mode, show the same complete layered front view without animation or parallax.

## Reveal sequence

1. Show a flat stack of paper layers for one second.
2. Separate the layers along the Z axis over three seconds.
3. Bring the cat forward and reveal the selected environment.
4. Display `3D scene ready — shaped by a human decision.`
5. Hold the interactive result for at least 12 seconds so the presenter can move the pointer.

Verify the immutable artifact is ready and active in the browser. End with:

`No external renderer. No hidden design tool. Built live by Codex inside SceneBoard.`
