# Demo 05 — Interactive Architecture Incident Map

PAIRING_CODE: `{{SB_CODE}}`

Read `demo/_COMMON.md` and follow it as mandatory operating policy. Then execute this runbook immediately.

## Goal

Show how Codex can explain a complex backend incident visually, including propagation, customer impact, and the safest recovery action.

## Connection and board

Request `board.read`, `board.write`, `board.hitl.request`, and `artifact.publish`, plus lifecycle `board.create`. Create:

`SceneBoard Demo — Incident Explained Visually`

## Architecture

Use this fictional system:

`Browser → API Gateway → Application API → Redis cache → MySQL database`

The application API also sends background work to a worker queue. Clearly label the scenario as a simulation.

## Human incident choice

Create one `choice` interaction:

Use the real SceneBoard interaction command and require the resulting choice card to appear in the automatic decision tray or as an inline `content.hitl` node before waiting.

- Question: `Which failure should Codex simulate?`
- Explanation: `Your choice changes the failure path and recovery recommendation. This is a fictional simulation and does not operate a real system.`
- Options:
  - `Redis cache unavailable`
  - `Database connection pool exhausted`
  - `Worker queue backlog`

Wait for the authoritative answer.

## Incident artifact

Create a 1200×675 animated architecture map titled `See the Failure Before Choosing the Fix`.

Required behavior:

- Render every component as a clearly labeled node connected by directional request paths.
- Begin in a healthy green state.
- Animate one request from the browser through the system.
- Trigger the selected failure, then propagate amber/red impact along only the affected paths.
- Keep unaffected components visibly healthy.
- Show a customer-impact panel in plain language.
- Show a recommended recovery sequence numbered 1–3.
- Allow the presenter to click `Healthy`, `Failure`, and `Recovery` to replay each state.
- Provide a legend that does not rely on color alone.

Scenario-specific truth:

- Cache unavailable: the application falls back to MySQL, increasing database load and response time; recovery isolates cache traffic and restores it gradually.
- Pool exhausted: API requests wait or fail while static delivery remains healthy; recovery reduces pressure, identifies long queries, and restores capacity carefully.
- Queue backlog: synchronous reads remain available but delayed background work grows; recovery protects new work, increases safe processing capacity, and drains the backlog.

Do not present the recommendation as an automatic production action. End on `A person still authorizes the recovery.`

## Recovery confirmation

Create one `confirmation` interaction:

Use the real SceneBoard interaction command and require the resulting confirmation card to appear before waiting.

- Title: `Approve the simulated recovery view?`
- Body: `This only advances the visual simulation. It does not execute commands or change infrastructure.`
- Confirm: `Show recovery`
- Cancel: `Keep the failure visible`

If approved, advance the artifact locally or publish a recovery revision that returns nodes to healthy in the stated order. If not, preserve the failure view.

End with:

`Codex explains the system. SceneBoard keeps the recovery decision human.`
