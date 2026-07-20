# Demo 04 — Animated Data Story

PAIRING_CODE: `{{SB_CODE}}`

Read `demo/_COMMON.md` and follow it as mandatory operating policy. Then execute this runbook immediately.

## Goal

Turn a dense operational dataset into a short, visual explanation that a first-time viewer can understand without reading raw JSON or logs.

## Connection and board

Request `board.read`, `board.write`, and `artifact.publish`, plus lifecycle `board.create`. Create:

`SceneBoard Demo — Data Becomes a Story`

## Fixed illustrative dataset

Use this explicitly synthetic seven-day support dataset:

| Day | Requests | Resolved | Median response | Satisfaction |
|---|---:|---:|---:|---:|
| Mon | 120 | 111 | 18 min | 91% |
| Tue | 145 | 132 | 21 min | 89% |
| Wed | 210 | 171 | 38 min | 78% |
| Thu | 238 | 190 | 44 min | 74% |
| Fri | 184 | 176 | 24 min | 86% |
| Sat | 98 | 96 | 15 min | 93% |
| Sun | 84 | 83 | 13 min | 95% |

The story is: demand rose sharply on Wednesday and Thursday, response time worsened, and satisfaction recovered after the backlog fell. Label all figures as illustrative sample data.

## Data-story artifact

Create a 1200×675 animated dashboard titled `From 28 Numbers to One Clear Decision`.

Stage the explanation over 8–10 seconds:

1. Briefly show a compact raw-data grid labeled `Illustrative sample data`.
2. Transform it into an animated request-volume line or bar chart.
3. Highlight Wednesday and Thursday with a visible annotation: `Demand spike`.
4. Reveal response time and satisfaction as synchronized overlays.
5. Finish with three large conclusions:
   - `Demand peaked on Thursday.`
   - `Response time more than doubled from Sunday to Thursday.`
   - `The recovery began as the backlog cleared on Friday.`
6. End on an action card: `Decision: add temporary coverage before the midweek peak.`

All numeric statements must be calculated correctly from the table. Motion must guide attention but the final static frame must contain the complete conclusion. Add a replay button that restarts only the local animation.

Use SVG or Canvas with accessible text equivalents. Do not imply the sample data is live or belongs to a real company.

Hold the final decision frame for at least eight seconds. End with:

`SceneBoard turns an AI analysis into a decision people can see.`

