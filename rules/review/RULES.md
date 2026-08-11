# Code Review Rules

Load this file with `rules/code/RULES.md` before reviewing a source change or assessing merge readiness.

## Scope and evidence

- Identify the review base and target, then inspect the complete diff, applicable rules, adjacent contracts, and changed tests.
- Review the requested change and its direct consequences. Report unrelated pre-existing issues separately so they do not create hidden scope.
- Trace claims to repository evidence: a file and location, a contract or invariant, and a concrete failure mode. Do not block on preference alone.
- Distinguish executed verification from inspection or inference. Never report a runtime path as verified when it was not run.

## Severity and merge decision

- **Blocker**: the change can expose secrets, bypass authorization, lose or corrupt durable data, make deployment unsafe, or requires a destructive operation without explicit approval. It must be resolved before merge.
- **Major**: the change has a reproducible correctness defect, breaks an API or compatibility contract, omits a required migration, or leaves the intended behavior materially unverified. Resolve it or record explicit owner acceptance of the remaining risk before merge.
- **Minor**: the change has a localized maintainability, readability, or resilience issue without a demonstrated contract failure. It is non-blocking unless the applicable rules make it required.
- Formatting already enforced by repository tooling is not a review finding unless it prevents validation or obscures a behavioral change.

## Finding format

- State the severity, affected file and location, violated contract, user or system consequence, and the smallest evidence-backed correction direction.
- Keep separate defects as separate findings. Do not combine independent risks into a vague summary.
- If no blocking findings remain, say so and list any tests, environments, or integration surfaces that were not verified.

## Reviewer independence and disagreement

- Human and automated reviewers use the same evidence and severity thresholds. Automated review must not claim authority, execution, or context it did not have.
- A reviewer must not silently edit the acceptance criteria to make the implementation pass.
- When reviewers disagree, preserve the competing evidence and tradeoff in the review record. A blocking finding remains open until it is corrected or the accountable owner explicitly accepts the documented risk.
