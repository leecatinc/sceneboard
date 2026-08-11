# SceneBoard visual composer

## Purpose and authority

`SKILL.md` routes composition work. This reference explains the local authoring tools; [commands.md](commands.md), [scene-contract.md](scene-contract.md), and [artifacts.md](artifacts.md) remain authoritative for wire inputs, native scenes, publication, isolation, and runtime behavior. The router and scene contract share one rule: choose a faithful native representation first and escalate only when materially required behavior or expressiveness is unavailable.

## Local path resolution

Run these dependency-free tools from the project root:

```text
node skills/sceneboard/scripts/scene-recipe.mjs ...
node skills/sceneboard/scripts/scene-artifact.mjs ...
```

They resolve `assets/visual-presets/` and `assets/artifact-templates/` relative to their installed modules. The current directory, environment, configuration, command arguments, and recipe data cannot redirect those catalogs.

## Native-first decision

| Route                   | Use when                                                                                                                                                                                                                                        | Do not use when                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Native recipe or preset | `layout.split`, `layout.grid`, `layout.tabs`, `layout.canvas`, `content.markdown`, `content.code`, `content.table`, `content.chart`, `content.map`, `content.drawing`, `content.status`, or `content.progress` faithfully expresses the result. | Do not escalate ordinary architecture, flow, drawing, canvas, table, chart, or presentation work merely for decoration. |
| Artifact composer       | Custom SVG, Canvas, HTML/CSS/JavaScript, accessible animation, specialized behavior, or the exact `발표자료`/case-insensitive `ppt` slide-deck exception is required.                                                                           | Do not use an artifact where native content and layouts preserve the same meaning.                                      |

Never use a content delivery network, external font/script/resource, invented identifier, unpublished placement, capability self-approval, or a mutation without an observed head and explicit key.

## Native recipe commands and outputs

```text
scene-recipe.mjs validate [FILE|-]
scene-recipe.mjs compile [FILE|-] [--output scene|scene-replace-input]
  [--board-id ID --expected-revision-id ID --idempotency-key KEY]
scene-recipe.mjs preset-list
scene-recipe.mjs preset-compile NAME [--output scene|scene-replace-input]
  [--board-id ID --expected-revision-id ID --idempotency-key KEY]
scene-recipe.mjs --help
```

The friendly catalog is `presentation`, `dashboard`, `architecture`, `markdown`, `code`, `table`, `chart`, `map`, `drawing`, `status`, `progress`, and `exact-node`. Default output is exact `{protocolVersion:1,type:"scene",root}`. The `scene-replace-input` output is exact `{boardId,expectedRevisionId,idempotencyKey,scene}` and requires all three bindings. Validation returns `{ok:true,recipeVersion:1,nodeCount}` after a full compile. These local commands have no network or board side effect. Identical logical objects compile byte-identically; array order remains intentional and identity-significant.

## Native preset catalog

- `architecture-overview`: canvas-based architecture notes and drawing.
- `comparison`: criteria-by-option table.
- `dashboard`: grid of status, progress, chart, and notes.
- `presentation`: three-page tabs presentation.
- `roadmap-status`: vertical overview, progress, and health stack.
- `study-brief`: structured explanatory study document.

All six compile only to trusted native nodes.

## Artifact commands and outputs

```text
scene-artifact.mjs validate [FILE|-]
scene-artifact.mjs compile [FILE|-]
scene-artifact.mjs template-list
scene-artifact.mjs place [FILE|-]
scene-artifact.mjs --help
```

Templates are `animated-data-story`, `architecture-map`, `demo-showcase`, `metric-story`, `process-flow`, `slide-deck`, `threejs-showcase`, `timeline`, `webgl-showcase`, and `workflow-graph`. Motion is one of `none`, `subtle`, `staged`, or `focus`.

`workflow-graph` is the closed review surface for a validated WorkflowSpec. It is not the ordinary
flow-decoration route: follow [graph-engineering.md](graph-engineering.md) for source boundaries,
provenance, validation, capability-aware compilation, publication, and conversational edits. Nodes
and edges are independently inspectable. Every variant exposes canonical JSON through the
`JSON export` modal immediately after `Selected`; the capability-aware variant adds `Copy JSON`
inside that modal, while manual mode offers read-only inspection and selection without requesting a
capability. In the authenticated board, prefer the host's `Fill area` view so the responsive
graph owns the remaining viewport instead of inheriting the template's intrinsic aspect ratio. The
graph's `Fit` control automatically contains the measured content, while the host's `Fit page`,
`Fit width`, and `100%` remain explicit user-selectable iframe sizing fallbacks.

`slide-deck` is the closed 1920×1080 PPT-style deck. It is an explicit routing
exception only for requests containing `발표자료` or case-insensitive `ppt`; ordinary
presentation and document work remains native-first. Its schema, content limits,
navigation, accessibility, and verification contract are in
[slide-deck.md](slide-deck.md).

`demo-showcase` is the closed recording template for SceneBoard's richer local demonstrations. Its exact content is `{kind,selection,phase}`. Supported combinations are:

- `illustration`: `sunny-garden|space-adventure|rainy-city` with `outline|color`.
- `diorama`: `golden-garden|space-observatory|neon-street` with `ready`.
- `prototype`: `calm-itinerary|visual-explorer|risk-checker` with `initial|improved`.
- `data-story`: `support-week` with `ready`.
- `incident`: `cache-unavailable|pool-exhausted|queue-backlog` with `failure|recovery`.
- `mission-control`: `launch-readiness` with `ready`.
- `code-review`: `no-charge|checkout-speed|concurrent-inventory` with `review|final`.

The template emits only its compiler-owned local interaction program. It requests no capabilities and performs no network access, download, navigation, storage, or external resource load. Use the human's authoritative HITL answer to choose `selection`; never default or invent it.

`threejs-showcase` is the preferred closed high-quality 3D template. Its exact content is `{scene,camera}`. Supported scenes are `garden-cat`, `space-cat`, and `neon-cat`; camera is `orbit` or `still`. The artifact runtime injects its pinned, content-hashed Three.js r184 trusted runtime asset only when this closed template's recognized runtime marker is present. The authored artifact requests no network capability and contains no dependency URL. The renderer uses antialiasing, capped high-density output, physically lit standard materials, soft shadows, Advanced Color Encoding System (ACES) filmic tone mapping, fog, pointer orbit, context-loss handling, reduced-motion handling, responsive resize observation, and explicit disposal.

`webgl-showcase` is the engine-free true-3D alternative with the same exact `{scene,camera}` content. It uses compiler-owned WebGL 1 shaders and geometry, capped high-density rendering, pointer camera movement, context-loss handling, reduced-motion handling, and responsive resize observation. Use it when the smallest runtime surface matters more than advanced lighting and materials.

Compile returns exact `{artifactRecipeVersion:1,type:"artifact-draft",template,motion,source:{artifactId:null,html,css,javascript,requestedCapabilities},placement:{nodeId,title,fallbackText}}`. Place accepts `{artifact:{artifactId,versionId},placement:{nodeId,title,fallbackText}}` and returns one exact `content.artifact` node. Templates request no capabilities except `workflow-graph`: `copyMode:"clipboard"` and the compatibility alias `copyMode:"export"` request only `clipboard.write`, while `copyMode:"manual"` requests none. Select a host-copy variant only after a fresh server capability read. Neither the model nor this compiler approves capabilities. The server does not sanitize or rewrite the separate JavaScript field, so use only compiler-owned closed templates.

## Two-stage publish and place

1. Compile and inspect the unpublished draft. It cannot be placed directly and has no immutable artifact identifiers.
2. Re-read `board_scene_get`. Call `board_artifact_put` with exact `{boardId,expectedRevisionId,idempotencyKey,artifactId:null,html,css,javascript,requestedCapabilities}` using draft source plus the observed head and a fresh key.
3. Extract the immutable pair only after successful publication: use `result.artifact.artifact.{artifactId,versionId}` from the documented MCP command result, or `$.result.result.artifact.artifact.{artifactId,versionId}` from the official API process wrapper. Publication neither creates nor returns a board revision. A missing field at the selected transport's exact path is an invalid response, not permission to guess identifiers or publish replacement content.
4. Re-read `board_scene_get` because another writer may have advanced the head. Use `place` with the immutable pair and draft placement.
5. Include the resulting `content.artifact` node in one `board_scene_replace` or bounded `board_scene_patch`, with that freshly observed `expectedRevisionId` and a distinct `idempotencyKey`.

Never invent pre-publication IDs, pass the draft to `place`, reuse a key for a different operation, or claim publication itself rendered in the browser.

## Deterministic batch discipline

Keep stable semantic `key` values and generated node identities, preserve intentional array order, group related visuals into one closed recipe, compile and inspect exact JSON, and mutate once. Do not translate a single composition into a long chat-authored stream of tiny writes. MCP remains preferred; use the bundled API adapter only when MCP descriptors are absent, and never switch after an MCP authentication, permission, validation, rate-limit, conflict, timeout, or backend failure.

## Accessibility and motion

Apply the canonical [human-readable delivery contract](../SKILL.md#human-readable-delivery-contract): every visible surface must explain itself in plain language. Include labels, complete static semantic facts, and `fallbackText` or accessible ARIA text. Motion should improve comprehension, never carry unique meaning, and every motion level must retain the same ordered facts when reduced motion is requested. If artifact runtime or browser verification is unavailable, use native nodes carrying the same information where possible and report persistence separately from rendering.

## Visual quality baseline

- Design recording-oriented work for a 1920×1080 desktop viewport and a clear 16:9 composition. Fill the available SceneBoard content area; avoid narrow fixed columns, accidental letterboxing, and layouts whose important subject becomes too small after fit scaling.
- Prefer SVG for illustrations, diagrams, icons, and line art so paths stay sharp at every zoom. Prefer semantic HTML/CSS for application mockups and text so labels remain selectable, accessible, and crisp. Do not rasterize text or interface controls.
- Use intentional hierarchy, consistent spacing, strong contrast, large recording-readable labels, and restrained motion. Keep the primary subject visually dominant and inside the safe central area.
- For Canvas, treat CSS size as layout size and set its backing dimensions to `round(cssSize × min(devicePixelRatio, 2))`; reset the drawing transform to that same ratio and redraw through `ResizeObserver`. Never assume the HTML width/height attributes match the displayed size.
- For WebGL, request antialiasing, enable depth testing, set the drawing buffer from the displayed size at `min(devicePixelRatio, 2)`, update `gl.viewport` after every resize, and keep animation near 60 frames per second. Stop unique motion under `prefers-reduced-motion`, handle context loss without exposing internals, and keep a complete accessible text description over or beside the canvas.
- Recompute geometry or rendering whenever the artifact viewport or SceneBoard fit mode changes. Use `requestResize` only with the template's declared intrinsic size; it does not replace responsive rendering.
- Treat the host's `Fill area` mode as a responsive viewport contract, not as a non-uniform stretch. Workflow graphs and responsive applications should consume the full iframe dimensions. Fixed slide decks must preserve their internal canvas aspect ratio even when the outer iframe fills the board.
- Prefer `threejs-showcase` when polished depth, lighting, soft shadows, materials, and camera motion matter. Three.js r184 is supplied only by the artifact runtime as a trusted content-hashed local asset. Never paste a minified engine into an artifact, reference a CDN, or request network access to fetch a renderer.
- Prefer `webgl-showcase` for a smaller engine-free 3D surface or when directly authored shaders are the point of the demonstration.

## Compact native example

```json
{
  "recipeVersion": 1,
  "root": {
    "kind": "presentation",
    "activePageKey": "summary",
    "pages": [
      {
        "key": "summary",
        "label": "Summary",
        "content": {
          "kind": "markdown",
          "markdown": "# Summary\n\nExplain the outcome in plain language."
        }
      }
    ]
  }
}
```

Compile with `scene-recipe.mjs compile recipe.json --output scene`, inspect the scene, then bind it once with `--output scene-replace-input --board-id BOARD_ID --expected-revision-id REVISION_ID --idempotency-key UNIQUE_KEY`.

## Compact artifact example

```json
{
  "artifactRecipeVersion": 1,
  "template": "metric-story",
  "placementKey": "metric-summary",
  "title": "Metric summary",
  "fallbackText": "The metric and its trend are listed below.",
  "theme": "light",
  "size": { "width": 960, "height": 540 },
  "motion": "subtle",
  "content": {
    "metrics": [
      {
        "label": "Completion",
        "value": "75%",
        "detail": "Three of four stages are complete.",
        "trend": "up"
      }
    ]
  }
}
```

Compile with `scene-artifact.mjs compile`, publish the exact draft source through `board_artifact_put`, extract the immutable identifiers from the selected transport's exact path documented above, re-read `board_scene_get`, and send `{"artifact":{"artifactId":"PUBLISHED_ID","versionId":"PUBLISHED_VERSION"},"placement":DRAFT_PLACEMENT}` to `scene-artifact.mjs place`. Put the returned node into one scene mutation using the fresh head and a new key.
