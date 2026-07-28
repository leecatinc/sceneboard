# Retention backup and restore drill

Run the drill with the restricted backup/restore operator. Create an isolated source backup,
restore it into a newly generated quarantine schema, and run the registered schema projection plus
anchor/payload/catalog/hold/reference integrity probes. Production schemas are never overwritten.

Record both successful and failed attempts. The evidence JSON consumed by
`scripts/sceneboard-retention-restore-drill.mjs` has the exact certificate fields documented by the
runtime migration. `expiresAt` must equal `certifiedAt + 30 days`. The script is the sole producer:
it signs canonical evidence with `RETENTION_CERTIFICATE_HMAC_KEY` and appends it to
`retention_restore_drill_attempts`.

Enablement reads only the highest `attemptSeq` for the running `deploymentId`. It verifies the HMAC
in constant time and requires an unexpired all-success result with exact registry and projection
digests. A newer failed attempt overrides every older success.
