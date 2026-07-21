#!/usr/bin/env bash
# SceneBoard Artifact Runtime — dev/staging launcher.
#
# Regenerates the resolved public-origin input files and a fresh v2 auth-origin
# evidence (validity is exactly 15 minutes) on EVERY start, then execs the runtime
# server. This keeps PM2 restarts working: a plain `node main.js` would fail after the
# evidence expires, so evidence must be regenerated immediately before each boot.
#
# Fail-closed: any missing required env var or a failed evidence generation aborts
# with a non-zero exit and the server is never started. Only public origin values are
# written to the input files — never secrets.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"

FE="${ARTIFACT_RUNTIME_FRONTEND_RESOLVED_INPUT_FILE:?frontend input path is required}"
BE="${ARTIFACT_RUNTIME_BACKEND_RESOLVED_INPUT_FILE:?backend input path is required}"
RT="${ARTIFACT_RUNTIME_RESOLVED_INPUT_FILE:?runtime input path is required}"
EV="${ARTIFACT_RUNTIME_EVIDENCE_FILE:?evidence path is required}"

mkdir -p "$(dirname "$EV")" "$(dirname "$FE")" "$(dirname "$BE")" "$(dirname "$RT")"

printf '{"NEXT_PUBLIC_BOARD_API_URL":"%s","NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN":"%s"}\n' \
  "${ARTIFACT_RUNTIME_API_ORIGIN:?}" "${ARTIFACT_RUNTIME_ORIGIN:?}" > "$FE"
printf '{"APP_ENV":"%s","BOARD_ALLOWED_ORIGINS":"%s","BOARD_PUBLIC_API_ORIGIN":"%s"}\n' \
  "${APP_ENV:?}" "${ARTIFACT_RUNTIME_APP_ORIGIN:?}" "${ARTIFACT_RUNTIME_API_ORIGIN:?}" > "$BE"
printf '{"ARTIFACT_RUNTIME_APP_ORIGIN":"%s","ARTIFACT_RUNTIME_API_ORIGIN":"%s","ARTIFACT_RUNTIME_ORIGIN":"%s"}\n' \
  "${ARTIFACT_RUNTIME_APP_ORIGIN:?}" "${ARTIFACT_RUNTIME_API_ORIGIN:?}" "${ARTIFACT_RUNTIME_ORIGIN:?}" > "$RT"

node "$ROOT/scripts/verify-auth-origin-topology.mjs" \
  --frontend-env "$FE" --backend-env "$BE" --runtime-env "$RT" --out "$EV"

exec node "$ROOT/packages/artifact-runtime/dist/node/server/main.js"
