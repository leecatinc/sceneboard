# SceneBoard pairing-claim calibration evidence

Status: **BLOCKED — isolated MySQL calibration evidence not yet supplied**

`PAIRING_FAILURE_MIN_MS=100` and `PAIRING_FAILURE_JITTER_MS=20` are implementation candidates. Pairing exposure remains blocked until a disposable, migration-certified MySQL schema supplies a local harness that creates fresh canonical fixtures and measures the real repository lookup/lock/HMAC plus padded response path.

The operator command is `npm run security:calibrate:pairing --workspace sceneboard-be`. It refuses to start unless all of these are present:

- `CONFIRM_ISOLATED_PAIRING_CALIBRATION=I_CONFIRM_THIS_IS_AN_ISOLATED_DISPOSABLE_SCHEMA`
- `PAIRING_CALIBRATION_HARNESS_MODULE=<reviewed local harness module>` exporting `createPairingClaimCalibrationHarness()`
- `PAIRING_CLAIM_CAPACITY_BUDGET_JSON=<documented deployment capacity budget>`
- the ordinary isolated-schema environment, including `PAIRING_FAILURE_MIN_MS` and `PAIRING_FAILURE_JITTER_MS`

The runner executes 500 attempts for each of unknown locator, matched verifier mismatch, expired, consumed, cancelled, and locked cohorts at concurrency 1/4/8. It records raw lookup/lock/HMAC and total response distributions, throughput, event-loop delay, and RSS delta. Acceptance requires a floor at least 25 ms over the slowest raw p99, jitter 10-25 ms, no pairwise cohort median delta over 10 ms, no p95 delta over 25 ms, and the supplied capacity budget.

The harness must own fixture teardown and must never print raw short codes, verifier material, proof challenges, credentials, cookies, email, IP, SQL credentials, or row identifiers.
