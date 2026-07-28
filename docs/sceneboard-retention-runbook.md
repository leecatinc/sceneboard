# SceneBoard revision retention runbook

Revision retention preserves immutable anchor rows while limiting accessible checkpoint payloads to
the newest configured revisions plus live strong holds. The default accessible count is 32.

Reclamation remains fail-closed unless the detached-payload parity, retained-reader flip,
detached-only writer, old-binary rejection, anchor-zero-byte proof, and latest signed restore drill
all match the running deployment.

Use the restricted operator identity:

```bash
node scripts/sceneboard-retention-operator.mjs status <board-pk>
node scripts/sceneboard-retention-operator.mjs dry-run <board-pk>
node scripts/sceneboard-retention-operator.mjs resume <board-pk> <recovery-id>
```

`status` and `dry-run` are read-only. A run admits at most 100 revisions and 32 MiB of stored
payload; one valid exact-32-MiB first row is admitted to guarantee progress. A lease lasts 60
seconds and is renewed every 20 seconds. Losing the board/run/owner/fence tuple stops the worker.

Items advance through `planned`, `refs_detached`, `payload_cleared`, `catalog_removed`, and
`complete`. The tenth durable failure enters `quarantined`; it never resumes automatically.
Before explicit resume, confirm the anchor and payload digests, current strong holds, resource
references, and candidate manifest. Never delete anchor rows.

For a restore race, exactly one outcome is acceptable: the restore hold commits and the request
returns 200, or reclamation commits first and the request returns the generic not-found response.
No cleared payload may be read.
