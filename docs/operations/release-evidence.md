# SceneBoard non-production release evidence

The release command is `npm run certify:release -- --profile=non-production`. It does not deploy, mutate dependencies, approve production, or repair sibling behavior.

## Attempt identity

Evidence lives under `.artifacts/certification/<source-commit>/<manifest-sha256>/<profile>/<attempt>/`. The immutable attempt envelope contains source commit, manifest SHA-256, observed input hashes, profile, attempt ID, and a distinct `correctness` or `capacity` lane. It does not duplicate `inventorySha256`; that value is read through the manifest.

The writer creates one owner token and permits only create-once records, content-addressed sanitized attachments, one first-failure record, create-once phase indexes, and one release index. Overwrite, path/symlink escape, token mismatch, second writer, duplicate finalization, or writes outside the attempt root fail closed.

For the presentation increment the release envelope also records
`presentationManifestSha256` and a `runExclusion` object. The AMD-06 exclusion
is created once at `exclusions/AMD-06.json` under the same attempt owner token.
Its attempt ID must match, and its SHA-256 must be repeated in the release
index. Token mismatch, overwrite, cross-attempt reuse, hash omission, or hash
drift fails closed.

`evidenceTreeSha256` hashes sorted finalized records, attachments, and phase indexes. It excludes the release index and owner record, avoiding self-reference. A rerun uses a new attempt ID and cannot replace earlier evidence.

Independent verification reopens every evidence leaf with no-follow descriptor semantics and
requires the current process owner, private mode, a regular single-link file, and a stable inode.
It recomputes the same sorted evidence tree and rejects a stale release-index hash, an altered
phase identity, hard-link aliases, permissive modes, and concurrent path substitution.
The public verifier and CLI require `release-index.json`; only the release finalizer may perform
the explicitly internal pre-finalization verification used immediately before create-once sealing.

## Release verdict

- `PASS`: every required live/static/manual row passed, watched inputs remained unchanged, and cleanup passed.
- `FAIL`: an executed assertion, safety check, evidence-integrity check, secret scan, or cleanup failed.
- `BLOCKED`: a source, configuration, dependency, owner, environment, or approval prerequisite is missing.
- `NOT_APPLICABLE`: optional rows only, with owner/reason/approval. It is forbidden for REQ-004, REQ-009, REQ-010, REQ-013, and REQ-014.

`excluded-by-user-current-run` is not a release verdict and cannot satisfy an
evidence row. For the current I-44 run it applies only to AMD-06 campaign IDs
`database-capacity`, `multi-client-capacity`, and `redis-loss-capacity`.
`presentation-release-index.v1.json` therefore reports `reducedAssurance:
true`; it never reports those campaigns as PASS, BLOCKED, NOT_APPLICABLE, or
ordinary deferred evidence.

The deterministic package, migration-source, security, browser-contract,
native-media, and skill/archive suites remain mandatory. Live MySQL/Redis
capacity campaigns and supervised browser acceptance require their isolated
environment and are recorded separately when available.

## API-key and export increment

I-53 records the exact seven-package test/typecheck/build matrix, artifact runtime tree hash,
migration 027, deterministic PDF/PPTX, owner browser/API-key parity, export runtime, native local
helper, secret scan, traceability, and manual acceptance rows inside the canonical attempt root.
The same closed row set requires current-attempt live security and quarantine-restore evidence,
plus deterministic backup/restore contract, database-boundary, and workspace-boundary evidence.
Catalog registration is not live evidence: all catalog case rows must be executed by the
repository-owned producer, authenticated with the trusted producer authority, retained as immutable
leaf attachments, and independently reverified with cleanup PASS. The restore producer derives its
identity from the trusted release attempt, performs the backup and quarantine restore itself, and
must pass byte integrity, projection, freshness, restricted-operator, and zero-residue checks.
The manifest is create-once and every row binds the same source commit, manifest SHA-256, profile,
environment, and attempt ID. A verifier accepts only that owned path and the exact canonical row
definitions; duplicate, extra, reduced, mixed-identity, stale, symlinked, or semantically mismatched
evidence fails closed. Pairing remains a required regression surface and is never replaced by
API-key evidence.

Browser export evidence must pin an explicit retained revision and prove that owner session and
properly scoped API-key paths succeed while viewer, editor, public-share and cross-account paths
fail closed. It also proves that cancel, retry and download do not mutate board/head/revision
payloads. A browser, MySQL, Redis, Chromium image or font prerequisite that is unavailable is
recorded as `BLOCKED` or `UNVERIFIED`, not inferred from unit tests.

The browser artifact contains one independently identified result for every mandatory principal,
format, failure, retry, focus, layout, pairing, retained-revision, payload-invariance, and cleanup
scenario. The rollup cannot treat a partial scenario set as PASS. Its MySQL schema name and owner
marker are derived from the attempt, and the complete schema is removed and checked for zero
residue in the first-failure-preserving cleanup path.

The retained and head fixture revisions use independent visual markers for both logical pages.
The certification decoder reads PDF page image streams and PPTX slide relationships/media in
logical order, requires the two retained markers, and rejects any head marker. Counts, container
signatures, requested revision IDs, or hard-coded page IDs alone cannot satisfy this gate. Browser
services are explicitly recorded as an isolated loopback fixture topology bound to the attempt;
they are not presented as the submitted deployment auth-origin topology.

No evidence/log/config/archive may contain a raw account key, bearer value, pairing proof/code,
real board or revision identifier, or absolute private path. Examples use synthetic identifiers
and `env://SCENEBOARD_API_KEY` references only.
