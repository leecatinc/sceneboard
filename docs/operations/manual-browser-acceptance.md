# SceneBoard manual browser acceptance

Follow [full-browser-test-scenario.md](full-browser-test-scenario.md) to verify
the complete product flow in order. This checklist adds viewport,
accessibility, and supervised-observation certification after that full
scenario passes.

Run only after automated correctness, security, Redis recovery, and browser certification passes in the same immutable attempt. Use one supervised installed browser process, a fresh context per case/principal/session generation, and no more than six tabs for an explicit case.

Check applicable D5/D7/D8 flows at `1440x900`, `1180x900`, and `760x900`, plus 200% zoom, keyboard-only navigation, forced colors, reduced motion, reconnect, pinned history, return to latest, artifact fallback/recovery, and destructive HITL non-approval.

For every case, verify focus order and visibility, accessible names/status announcements, no hidden response control in history, no model-facing cancel/supersede tool, no cookie/referrer leakage to the artifact runtime, and no residual cookie/storage/cache/service worker after context closure.

Screenshots, traces, and video default to off for secret/security rows. If required for manual evidence, capture only an approved sanitized frame and scan it before attachment. Browser crash, infinite loop, allocation pressure, or renderer poisoning requires a full process restart.

Record viewport, browser build hash, case ID, safe verdict, sanitized evidence hash, owner, and cleanup result. A manual observation cannot override an automated failure or blocked prerequisite.
