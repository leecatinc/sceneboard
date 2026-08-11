# Next.js Frontend Rules

- Preserve the App Router server/client boundary. Add `use client` only where browser state or browser APIs require it.
- Keep API calls and response parsing in the existing client layer rather than route components.
- Keep render-time state derivation pure. Side effects belong in effects, event handlers, or dedicated controllers.
- Keep owner-board and public-share routes as separate authorization contexts. Public-share rendering must remain anonymous-safe and must not activate owner-only board lifecycle behavior.
- Every durable artifact or HITL event must have a stable board/revision target before it reaches renderer state.
- Treat `NEXT_PUBLIC_` values as browser-visible and keep server-only export or credential configuration out of client modules.
- Validate API, media, authentication, and artifact-runtime origins as canonical origins before using them in requests or CSP directives.
- Preserve CSP, iframe isolation, origin validation, credential handling, localization, accessibility, focus management, and keyboard navigation contracts.
- Keep shared protocol types in `@sceneboard/board-schema` and reusable transport or rendering behavior in the owning shared package; do not duplicate those contracts in route code.
- Add focused regression coverage for routing, public-share access, pairing, live revision reconciliation, artifact lifecycle, HITL lifecycle, and viewport transforms when those paths change.
