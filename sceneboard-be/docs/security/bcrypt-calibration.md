# SceneBoard bcrypt calibration evidence

Status: **BLOCKED — deployment-class measurement not yet supplied**

The committed values `BCRYPT_COST=12`, `AUTH_FAILURE_MIN_MS=500`, and `AUTH_FAILURE_JITTER_MS=20` are implementation candidates, not approved deployment evidence. Signup/login must remain unexposed until this document is updated from a deployment-class run and the matching dummy hash, environment example, validation tests, and capacity assumption are reviewed together.

Run on the deployment CPU with an operator-owned, explicit capacity budget:

```sh
CONFIRM_DEPLOYMENT_CLASS_CPU=I_CONFIRM_THIS_IS_THE_DEPLOYMENT_CPU \
CALIBRATION_CPU_CLASS='deployment-cpu-class-label' \
BCRYPT_AUTH_CAPACITY_BUDGET_JSON='{"maxConcurrency":4,"minHashThroughputPerSecond":1,"minCompareThroughputPerSecond":1,"maxEventLoopDelayP95Ms":1000,"maxRssDeltaBytes":268435456,"maxBatchDurationMs":20000}' \
npm run security:calibrate:bcrypt --workspace sceneboard-be
```

The JSON numbers above are syntax examples only; the deployment owner must replace them with the documented SceneBoard authentication traffic and timeout budget. The command performs at least three hash/compare warmups and twenty isolated hash plus twenty compare samples at every cost 10-14. Costs passing the 200-350 ms median hash and sub-500 ms p95 gate are also measured at concurrency 1/4/8 for throughput, event-loop delay, memory, and batch duration. It exits `2` unless a deployment-class CPU is explicitly confirmed and one cost passes both latency and the supplied capacity budget.

Never paste raw passwords, hashes, cookies, tokens, database credentials, or production identifiers into this evidence. The calibration output contains only runtime/CPU labels and aggregate measurements.
