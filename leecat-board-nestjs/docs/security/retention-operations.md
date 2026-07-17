# SceneBoard security retention operations

The retention runner is an operator-only process. Application boot and HTTP handlers never import or invoke it.

- `npm run security:retention:status` performs read-only indexed aggregate scans and reports the exact due count plus oldest UTC timestamp for every target.
- `npm run security:retention:dry-run` acquires the zero-wait retention lock and executes the same bounded selectors without mutation.
- `npm run security:retention:run` acquires `leecat-board:security-retention:v1`, commits batches of at most 500 rows, and stops at 10,000 rows or 15 minutes.

Schedule `run` hourly only after deployment approval. Alert after three missing/failed runs, when the oldest due item exceeds 24 hours, or whenever a report has `capped:true`. An `overlap` outcome is safe and performs no selection or mutation. A failed batch rolls back that batch; earlier batches remain committed and the next invocation resumes from the indexed due set.

Every destructive batch rechecks the selected row's terminal state and cutoff inside its transaction. Active expiry additionally rechecks the family link and deadline under the global family -> pairing -> grant -> credential lock order. A concurrent state or link change therefore produces no early deletion or cross-family expiry.

Reports and audit metadata contain only mode, target names, counts, oldest UTC timestamps, outcome, cap state, and duration. They must never include session, CSRF, pairing, proof, grant, email, IP, or user-agent material.
