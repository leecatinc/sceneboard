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
