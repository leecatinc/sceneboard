# SceneBoard contract certification manifests

The D1-D9 baseline remains frozen in `contract-input-inventory.v1.json` and
`contract-manifest.v1.json`. It now contains 472 alias-independent resources,
30 migration registry entries, and 33 SQL assets. `npm run verify:contracts`
recomputes that baseline read-only.

The presentation increment has a separate closed authority:

- `presentation-contract-input-inventory.v1.json` lists the exact inputs.
- `presentation-contract-manifest.schema.json` rejects unknown top-level and
  nested fields.
- `presentation-contract-manifest.v1.json` materializes hashes and bridges
  REQ-118 through REQ-133, six approved decisions, the presentation/API-key/export increment, and
  D1 through D9.
- `presentation-release-index.v1.json` links the manifest hash and current-run
  AMD-06 exclusion hash.
- `run-exclusion.amd-06.v1.json` is the immutable, run-scoped exclusion record.

Run `npm run verify:presentation-contracts` to verify both the manifest and
release index. Normal verification never rewrites either file. Maintainers may
use `node scripts/verify-presentation-contract-manifest.mjs --write` only after
an intentional inventory/input change and must commit the inventory, generated
manifest, release index, and verification evidence together.

The presentation verifier rejects missing or reordered requirements and
decisions, owner drift, path aliases and symlinks, duplicate inputs, orphan
publishers, self-reference, migration sequence drift, exclusion-as-PASS, and a
release index without the exclusion content hash. The collision-free
presentation migration sequence is exactly 013 through 027.

The committed manifest owns only reproducible source hashes. It never embeds
its own hash, a source commit, or a runtime attempt identity. Runtime evidence
owns those values and uses the manifest SHA-256 as an immutable attempt input.

The I-53 cross-surface evidence set lives outside the source manifest at
`.hpipe/plan/evidence/I-53-certification/`. Its `manifest.json` closes the exact package commands
and certification row IDs. Each `results.jsonl` row records one `PASS`, `FAIL`, `BLOCKED`, or
`UNVERIFIED` result with a redacted log reference and artifact hash. Missing infrastructure,
skipped assertions, absent artifacts and manual observations never become `PASS`.

`node scripts/verify-ai-export-certification.mjs
../.hpipe/plan/evidence/I-53-certification/manifest.json` verifies the closed row set and emits the
derived rollup only when every required input row is present and valid. Any required non-PASS row
keeps the rollup non-PASS and names the release blocker.
