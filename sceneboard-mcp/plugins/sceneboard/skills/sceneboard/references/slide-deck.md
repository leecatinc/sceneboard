# SceneBoard closed slide deck

## Exact routing contract

Use `slide-deck` only when the user's request contains either:

- the exact Korean string `발표자료`; or
- `ppt` in any letter case.

Examples that route to `slide-deck`: `발표자료로 만들어줘`, `PPT로 만들어줘`, and
`ppt 자료`. The words `presentation` or `프레젠테이션`, a generic board update,
Markdown document, report, meeting material, or tabs request do not route to this
template. Those requests retain the native-first policy and may use the native
`presentation` recipe.

## Closed recipe schema

The common artifact fields remain
`{artifactRecipeVersion,template,placementKey,title,fallbackText,theme,size,motion,content}`.
For this template, require `template:"slide-deck"`, `theme:"dark"`,
`size:{width:1920,height:1080}`, and:

```text
content = {
  deckLabel: string,
  slides: Slide[1..20]
}

Slide common = {
  key: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
  type: "cover" | "problem" | "process" | "business-model" |
        "metrics" | "evidence" | "timeline" | "closing",
  eyebrow: string | null,
  title: string,
  subtitle: string | null
}

cover += { badges: string[1..4], highlights: {label,detail}[1..3] }
problem += { items: {label,detail}[2..4] }
process += { steps: {label,detail}[3..6] }
business-model += {
  offers: {label,price,detail,features:string[1..4]}[2..3]
}
metrics | evidence += { metrics: {value,label,detail}[2..4] }
timeline += { events: {date,label,detail}[3..7] }
closing += { actions: {label,detail}[1..3], closingLine:string }
```

All objects are closed. Unknown fields, unknown types, duplicate keys, empty required
text, oversized fields, more than 20 slides, or more than 8,192 user-text Unicode
scalars are rejected. User text is HTML-escaped and cannot provide HTML, CSS, or
JavaScript.

## Presentation composition

- Preserve one primary idea per slide. Compress source prose; do not paste long
  paragraphs.
- Use `cover` for the value proposition, `problem` for concise problem cards,
  `process` for an ordered flow, `business-model` for bounded offers, `metrics` or
  `evidence` for judge-visible proof, `timeline` for milestones, and `closing` for
  the conclusion and next action.
- Keep titles concrete and recording-readable. Prefer 2–4 cards or 3–6 steps over
  dense prose.
- Never rasterize text. The compiler emits semantic text, CSS cards, badges, lines,
  and shapes.

## Runtime and accessibility contract

The compiler owns the complete HTML, CSS, and JavaScript. The generated deck uses a
1920×1080 design stage and scales it proportionally to the artifact viewport. It
must expose previous and next buttons, left/right and Page Up/Page Down keyboard
navigation, Home/End boundaries, current/total page text, and an ARIA progress bar.
The first and last controls are disabled at their respective boundaries. Inactive
slides are `hidden`, `aria-hidden`, and inert; every slide has a labeled heading and
slide semantics.

Motion never carries unique meaning. The same content remains present under
`prefers-reduced-motion`. The deck requests `requestedCapabilities:[]`, performs no
network operation, loads no external font, script, style, image, or content delivery
network resource, and requests its declared 1920×1080 intrinsic size only through
the SceneBoard artifact bridge.

## Verification

Compile the recipe twice and require byte-identical drafts. Inspect the draft before
publication and confirm:

- `source.artifactId` is `null`;
- `requestedCapabilities` is an empty array;
- the source contains no external dependency or URL load;
- every slide title and all decision-critical facts are present as escaped text;
- navigation, progress, boundaries, responsive scaling, and reduced motion are
  present.

For browser verification, render at 1920×1080, move from the first to final slide by
button and keyboard, verify the current/total display and disabled boundaries, then
repeat at a narrow viewport and with reduced motion. Persistence in SceneBoard and
successful browser rendering are separate evidence.
