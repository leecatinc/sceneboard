# SceneBoard isolated backup and restore certification

Backup/restore evidence is live-required and currently blocked until approved isolated MySQL 8.0 floor/ceiling environments are available.

## Safety contract

- Use a new attempt-owned source schema and a separately named quarantine restore schema.
- Record engine version, SQL mode, UTC, character set, collation, InnoDB/check enforcement, registry hash, owner token, and initial-state hash before state changes.
- Back up only the isolated representative schema. Never target production or a shared schema.
- Restore only into an empty quarantine schema. Never overwrite or promote the source schema in place.
- Recollect metadata and run complete schema/projection/integrity certification after restore.
- Promotion means selecting a passing quarantine identity for a later isolated certification phase; it is not production deployment.

## Required scenarios

Run fresh and exact-state adopt with `FULL_OFFLINE`, interrupted restart with `BOUNDED_RESTART`, `RESUMABLE_AUDIT`, and quarantine restore. Every scenario owns a distinct schema. A failed or partially migrated schema cannot be reused.

D3/D7/D8 migrations are forward-only. Never run a down migration, drop, or truncate them. D2's three down assets are registry evidence, not blanket rollback authorization.

If backup, restore, metadata comparison, checksum, cleanup, or owner verification fails, keep exposure stopped, retain sanitized first-failure evidence, and route correction to the owning D2-D8 contract.
