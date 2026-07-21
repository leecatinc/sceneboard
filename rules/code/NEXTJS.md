# Next.js Frontend Rules

- Preserve the App Router server/client boundary. Add `use client` only where browser state or browser APIs require it.
- Keep API calls and response parsing in the existing client layer rather than route components.
- Keep render-time state derivation pure. Side effects belong in effects, event handlers, or dedicated controllers.
- Every durable artifact or HITL event must have a stable board/revision target before it reaches renderer state.
- Preserve CSP, iframe isolation, origin validation, credential handling, localization, accessibility, and keyboard navigation contracts.
- Add regression coverage for routing, pairing, live revision reconciliation, artifact lifecycle, HITL lifecycle, and viewport transforms when those paths change.
