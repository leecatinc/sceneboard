# Demo 03 — Clickable App Prototype

Read `demo/_COMMON.md` and follow it as mandatory operating policy. Then execute this runbook immediately.

## Goal

Demonstrate that a Codex result can become an immediately testable product surface instead of a long block of implementation text.

## Shared board

Reuse the approved connection and exact shared board required by `_COMMON.md`. Complete the mandatory shared-board reset, then begin this take on the empty live Scene. Do not pair again or create another board. Use `SceneBoard Demo — Clickable Product Prototype` as the visible demo heading.

## Product brief

Use this fixed brief:

`Design a mobile trip-planning assistant that turns a complicated itinerary into one calm, actionable day plan.`

First publish a concise native scene titled `From Product Brief to Working Prototype` showing the user problem and three success criteria: understandable at a glance, one primary action, and visible risk warnings.

## Human design decision

Create one `choice` interaction:

Use the real SceneBoard interaction command and require the resulting choice card to appear in the automatic decision tray or as an inline `content.hitl` node before waiting.

- Question: `Which experience should Codex prototype?`
- Explanation: `The choice changes navigation and visual emphasis, while keeping the same trip-planning goal.`
- Options:
  - `Calm itinerary` — a timeline-led daily plan with minimal decisions.
  - `Visual explorer` — destination cards, map-like positioning, and discovery emphasis.
  - `Risk checker` — booking confidence, timing conflicts, and refund warnings first.

Wait for the answer.

## Clickable artifact

Create one polished 1200×675 artifact that displays a phone frame beside a plain-English product explanation. Inside the phone, implement at least four locally interactive states:

1. Home/dashboard.
2. A day-plan or destination detail.
3. A modal or bottom sheet opened by the primary action.
4. A confirmed/saved state with visible feedback.

Required interactions:

- Buttons and tabs work with pointer and keyboard.
- A progress or transition animation makes navigation legible.
- A `Reset demo` control restores the initial screen locally.
- A small event log outside the phone explains actions in human language, for example `The traveler opened Tuesday's plan.`
- No interaction leaves the artifact, downloads data, or makes a network request.

Tailor the information hierarchy and screens to the person's actual choice. Use realistic but explicitly illustrative trip content; do not claim live prices or availability.

## Revision improvement

After the first prototype is placed, create a `confirmation` interaction:

Use the real SceneBoard interaction command and require the resulting confirmation card to appear before waiting.

- Title: `Should Codex make the primary action easier to find?`
- Body: `Approving will preserve this prototype in history and create a new revision with stronger hierarchy, clearer wording, and a more visible primary action.`
- Confirm: `Yes, improve it`
- Cancel: `No, keep this version`

If approved, publish a second immutable prototype with the same functionality but a materially clearer primary action and accessible focus states. Preserve both revisions and show `Previous`/`Latest` when browser control is available.

End with:

`A product conversation became a testable interface — built live by Codex.`
