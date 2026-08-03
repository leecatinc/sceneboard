# Retention backup and restore drill

Run the drill with the restricted backup/restore operator. Create an isolated source backup,
restore it into a newly generated quarantine schema, and run the registered schema projection plus
anchor/payload/catalog/hold/reference integrity probes. Production schemas are never overwritten.

Record both successful and failed attempts. `scripts/sceneboard-retention-restore-drill.mjs` does
not accept caller assertions: it creates an attempt-owned source schema and backup, restores into a
new attempt-owned quarantine schema, recomputes the media, projection, and integrity digests, and
checks zero residue before persisting a certificate. `expiresAt` equals `certifiedAt + 30 days`.
The script signs canonical producer evidence with `RETENTION_CERTIFICATE_HMAC_KEY` and appends it
to `retention_restore_drill_attempts` only after the live restore and cleanup succeed.

Enablement reads only the highest `attemptSeq` for the running `deploymentId`. It verifies the HMAC
in constant time and requires an unexpired all-success result with exact registry and projection
digests. A newer failed attempt overrides every older success.
