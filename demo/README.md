# SceneBoard Independent Demo Library

This directory contains independent recording runbooks. Each numbered Markdown file can be pasted into Codex CLI for a separate take. Pair SceneBoard once, reuse the same approved connection and board for every take, and clear the current live Scene before each demo. English-only presentation copy and immutable revision history are preserved.

## Recommended clips

| File | What it proves | Suggested raw take |
|---|---|---:|
| `01-hitl-illustration.md` | A human decision controls an AI-created visual | 60–90 seconds |
| `02-3d-paper-diorama.md` | Codex can turn a decision into an interactive 3D artifact | 45–75 seconds |
| `03-interactive-app-prototype.md` | SceneBoard can host a clickable product prototype | 60–90 seconds |
| `04-live-data-story.md` | Dense data becomes an understandable animated explanation | 45–75 seconds |
| `05-architecture-incident.md` | A system failure becomes a visual, interactive incident map | 60–90 seconds |
| `06-revision-time-travel.md` | Every AI transformation remains inspectable in history | 45–60 seconds |
| `07-code-review-visual.md` | Codex explains a change to technical and nontechnical viewers | 45–75 seconds |

## Running one take

Complete one SceneBoard pairing before recording, then paste the selected file into Codex CLI. No new pairing code is required between demos.

```bash
codex exec -C /workspace/lc/leecat-board - < demo/03-interactive-app-prototype.md
```

The browser user approves the connection once before the first take. During each runbook, the user only answers its explicitly named Human-in-the-Loop cards. The runbook reuses the bound board and clears its current live Scene before starting; prior revisions remain available in history.

## Suggested three-minute edit

- 0:00–0:15 — Problem and the already-connected SceneBoard workspace.
- 0:15–0:50 — Human-guided illustration.
- 0:50–1:15 — 3D paper diorama.
- 1:15–1:45 — Clickable app prototype.
- 1:45–2:10 — Live data story.
- 2:10–2:35 — Architecture incident map or visual code review.
- 2:35–2:55 — Revision time travel.
- 2:55–3:00 — SceneBoard closing message.

Use only the strongest 20–35 seconds from each raw take. Record every run independently so one failed take cannot invalidate the others.
