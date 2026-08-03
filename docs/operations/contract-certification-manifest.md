# SceneBoard contract certification manifests

The D1-D9 baseline remains frozen in `contract-input-inventory.v1.json` and
`contract-manifest.v1.json`. It now contains 475 alias-independent resources,
32 migration registry entries, and 35 SQL assets. `npm run verify:contracts`
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
release index without the exclusion content hash. The presentation authority has an explicit
terminal migration boundary of 027. Verification compares the exact contiguous 013-through-027
registry slice; later entries 028 and 029 remain outside this historical boundary and cannot hide
an omission inside it.

The committed manifest owns only reproducible source hashes. It never embeds
its own hash, a source commit, or a runtime attempt identity. Runtime evidence
owns those values and uses the manifest SHA-256 as an immutable attempt input.

The I-53 cross-surface evidence set lives outside the source manifest at the canonical
`.artifacts/certification/<commit>/<manifest>/<profile>/<attempt>/` owned root. Its create-once
`manifest.json` closes the exact package commands and certification row IDs. Canonical JSON records
carry one `PASS`, `FAIL`, `BLOCKED`, or `UNVERIFIED` result, command-output digests, semantic artifact,
and the shared attempt identity. Missing infrastructure, skipped assertions, absent artifacts, and
manual observations never become `PASS`.

`verify-ai-export-certification.mjs` accepts only the five fixed identity arguments, reconstructs
the owned attempt path, requires the owned release index, and verifies the closed row set. It never
accepts an arbitrary manifest path, an unfinalized attempt, or rewrites a finalized attempt. Any
required non-PASS row keeps the derived rollup non-PASS and names the release blocker.

The repository-owned I-53 traceability authority is the canonical JSON value below. The release
producer reads this exact bounded block through an owned, no-follow descriptor and binds its digest
to the current source manifest and attempt. The independent verifier repeats the same closed-set
validation; prose or token substring matches are never accepted as traceability evidence.

<!-- I53_TRACEABILITY_AUTHORITY_V1
{"mappings":[{"evidenceKind":"schema-contract-test","issueId":"I-45","owner":"D1","producerRowId":"PKG-SCHEMA-TEST","requirementId":"REQ-134"},{"evidenceKind":"auth-origin-topology","issueId":"I-46","owner":"D2","producerRowId":"INT-AUTH-ORIGINS","requirementId":"REQ-135"},{"evidenceKind":"application-contract-test","issueId":"I-47","owner":"D3","producerRowId":"PKG-BE-TEST","requirementId":"REQ-136"},{"evidenceKind":"sdk-contract-test","issueId":"I-48","owner":"D4","producerRowId":"PKG-SDK-TEST","requirementId":"REQ-137"},{"evidenceKind":"browser-control-test","issueId":"I-49","owner":"D5","producerRowId":"PKG-FE-TEST","requirementId":"REQ-138"},{"evidenceKind":"runtime-smoke","issueId":"I-50","owner":"D6","producerRowId":"CERT-RUNTIME-SMOKE","requirementId":"REQ-139"},{"evidenceKind":"pdf-golden","issueId":"I-51","owner":"D7","producerRowId":"CERT-PDF-GOLDEN","requirementId":"REQ-140"},{"evidenceKind":"secret-scan","issueId":"I-52","owner":"D8","producerRowId":"CERT-SECRET-SCAN","requirementId":"REQ-141"},{"evidenceKind":"migration-projection","issueId":"I-53","owner":"D9","producerRowId":"CERT-MIG-027","requirementId":"REQ-142"},{"evidenceKind":"browser-scenarios","issueId":"I-53","owner":"D10","producerRowId":"CERT-BROWSER-E2E","requirementId":"REQ-143"},{"evidenceKind":"supervised-browser-observation","issueId":"I-53","owner":"D10","producerRowId":"MANUAL-BROWSER-ACCEPTANCE","requirementId":"REQ-144"}],"schemaVersion":1,"tools":[{"evidenceKind":"explicit-revision-browser-export","issueId":"I-53","owner":"D10","producerRowId":"CERT-BROWSER-E2E","toolName":"board_export"}]}
I53_TRACEABILITY_AUTHORITY_V1 -->
