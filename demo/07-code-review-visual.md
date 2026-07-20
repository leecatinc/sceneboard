# Demo 07 — Visual Code Review for Everyone

Read `demo/_COMMON.md` and follow it as mandatory operating policy. Then execute this runbook immediately.

## Goal

Translate a technical code change into one visual surface that both an engineer and a product stakeholder can understand.

## Shared board

Reuse the approved connection and exact shared board required by `_COMMON.md`. Complete the mandatory shared-board reset, then begin this take on the empty live Scene. Do not pair again or create another board. Use `SceneBoard Demo — Code Change Explained Visually` as the visible demo heading.

## Fictional change set

Use this safe illustrative change:

`The checkout API now validates inventory before charging a card. If inventory becomes unavailable, the request stops before payment and returns a clear retry message.`

The old flow was:

`Checkout request → Charge card → Reserve inventory → Confirmation`

The new flow is:

`Checkout request → Validate inventory → Charge card → Reserve inventory → Confirmation`

If validation fails, the new flow ends at `No charge made — ask the customer to retry.`

## Visual review artifact

Create a 1200×675 interactive comparison titled `One Code Change, Explained for Every Reviewer`.

Required layout:

- Left: `Before` flow with the risk point emphasized.
- Right: `After` flow with the new validation gate.
- Center or bottom: a plain-language customer-impact statement.
- A `Play request` button animates one order through both flows side by side.
- A `Simulate unavailable inventory` toggle demonstrates that the new flow stops before payment.
- A reviewer panel lists:
  - Benefit: fewer charges for unavailable items.
  - Tradeoff: one extra inventory check on checkout.
  - Verification: test successful checkout, unavailable inventory, and inventory changing during checkout.
- Use icons, labels, and movement; never rely on red/green color alone.

The simulation must be deterministic, local, and clearly labeled illustrative. It must not execute code or contact a payment system.

## Human review decision

After placing the artifact, create one `choice` interaction:

Use the real SceneBoard interaction command and require the resulting choice card to appear in the automatic decision tray or as an inline `content.hitl` node before waiting.

- Question: `What should the team verify first?`
- Explanation: `This records review priority only. It does not approve deployment or operate the checkout system.`
- Options:
  - `No charge occurs when inventory is unavailable.`
  - `Successful checkout remains fast and correct.`
  - `Concurrent inventory changes are handled safely.`

Wait for the answer, then publish a concise final scene that keeps the comparison visible and adds:

`Human review priority: <actual selected option>`

End with:

`Codex writes technical work. SceneBoard makes its impact reviewable by humans.`
