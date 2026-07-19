# SceneBoard visual composer

## Purpose and authority

`SKILL.md` routes composition work. This reference explains the local authoring tools; [commands.md](commands.md), [scene-contract.md](scene-contract.md), and [artifacts.md](artifacts.md) remain authoritative for wire inputs, native scenes, publication, isolation, and runtime behavior. The router and scene contract share one rule: choose a faithful native representation first and escalate only when materially required behavior or expressiveness is unavailable.

## Local path resolution

Run these dependency-free tools from the project root:

```text
node skills/sceanboard/scripts/scene-recipe.mjs ...
node skills/sceanboard/scripts/scene-artifact.mjs ...
```

They resolve `assets/visual-presets/` and `assets/artifact-templates/` relative to their installed modules. The current directory, environment, configuration, command arguments, and recipe data cannot redirect those catalogs.

## Native-first decision

| Route | Use when | Do not use when |
|---|---|---|
| Native recipe or preset | `layout.split`, `layout.grid`, `layout.tabs`, `layout.canvas`, `content.markdown`, `content.code`, `content.table`, `content.chart`, `content.map`, `content.drawing`, `content.status`, or `content.progress` faithfully expresses the result. | Do not escalate ordinary architecture, flow, drawing, canvas, table, chart, or presentation work merely for decoration. |
| Artifact composer | Custom SVG, Canvas, HTML/CSS/JavaScript, accessible animation, or specialized behavior is materially necessary and unavailable in trusted nodes. | Do not use an artifact where native content and layouts preserve the same meaning. |

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

Templates are `animated-data-story`, `architecture-map`, `metric-story`, `process-flow`, and `timeline`. Motion is one of `none`, `subtle`, `staged`, or `focus`.

Compile returns exact `{artifactRecipeVersion:1,type:"artifact-draft",template,motion,source:{artifactId:null,html,css,javascript,requestedCapabilities:[]},placement:{nodeId,title,fallbackText}}`. Place accepts `{artifact:{artifactId,versionId},placement:{nodeId,title,fallbackText}}` and returns one exact `content.artifact` node. Every shipped template requests `requestedCapabilities:[]`; neither the model nor this compiler approves capabilities. The server does not sanitize or rewrite the separate JavaScript field, so use only compiler-owned closed templates.

## Two-stage publish and place

1. Compile and inspect the unpublished draft. It cannot be placed directly and has no immutable artifact identifiers.
2. Re-read `board_scene_get`. Call `board_artifact_put` with exact `{boardId,expectedRevisionId,idempotencyKey,artifactId:null,html,css,javascript,requestedCapabilities}` using draft source plus the observed head and a fresh key.
3. Extract the immutable pair only from `result.artifact.artifact.{artifactId,versionId}` after successful publication. Publication neither creates nor returns a board revision.
4. Re-read `board_scene_get` because another writer may have advanced the head. Use `place` with the immutable pair and draft placement.
5. Include the resulting `content.artifact` node in one `board_scene_replace` or bounded `board_scene_patch`, with that freshly observed `expectedRevisionId` and a distinct `idempotencyKey`.

Never invent pre-publication IDs, pass the draft to `place`, reuse a key for a different operation, or claim publication itself rendered in the browser.

## Deterministic batch discipline

Keep stable semantic `key` values and generated node identities, preserve intentional array order, group related visuals into one closed recipe, compile and inspect exact JSON, and mutate once. Do not translate a single composition into a long chat-authored stream of tiny writes. MCP remains preferred; use the bundled API adapter only when MCP descriptors are absent, and never switch after an MCP authentication, permission, validation, rate-limit, conflict, timeout, or backend failure.

## Accessibility and motion

Apply the canonical [human-readable delivery contract](../SKILL.md#human-readable-delivery-contract): every visible surface must explain itself in plain language. Include labels, complete static semantic facts, and `fallbackText` or accessible ARIA text. Motion should improve comprehension, never carry unique meaning, and every motion level must retain the same ordered facts when reduced motion is requested. If artifact runtime or browser verification is unavailable, use native nodes carrying the same information where possible and report persistence separately from rendering.

## Compact native example

```json
{"recipeVersion":1,"root":{"kind":"presentation","activePageKey":"summary","pages":[{"key":"summary","label":"Summary","content":{"kind":"markdown","markdown":"# Summary\n\nExplain the outcome in plain language."}}]}}
```

Compile with `scene-recipe.mjs compile recipe.json --output scene`, inspect the scene, then bind it once with `--output scene-replace-input --board-id BOARD_ID --expected-revision-id REVISION_ID --idempotency-key UNIQUE_KEY`.

## Compact artifact example

```json
{"artifactRecipeVersion":1,"template":"metric-story","placementKey":"metric-summary","title":"Metric summary","fallbackText":"The metric and its trend are listed below.","theme":"light","size":{"width":960,"height":540},"motion":"subtle","content":{"metrics":[{"label":"Completion","value":"75%","detail":"Three of four stages are complete.","trend":"up"}]}}
```

Compile with `scene-artifact.mjs compile`, publish the exact draft source through `board_artifact_put`, extract `result.artifact.artifact.{artifactId,versionId}`, re-read `board_scene_get`, and send `{"artifact":{"artifactId":"PUBLISHED_ID","versionId":"PUBLISHED_VERSION"},"placement":DRAFT_PLACEMENT}` to `scene-artifact.mjs place`. Put the returned node into one scene mutation using the fresh head and a new key.
