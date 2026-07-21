// SceneBoard Artifact Runtime — dev/staging PM2 process.
//
// The launcher regenerates fresh 15-minute auth-origin evidence before every boot and
// is fail-closed, so evidence never goes stale across restarts. Bounded restart policy
// (max_restarts + min_uptime) prevents an infinite hot-loop if evidence generation
// keeps failing: PM2 marks the process `errored` instead of looping forever.
//
// Public origin topology (dev/staging):
//   app / API : https://sceneboard.leecat.co.kr
//   runtime   : https://sceneboard-artifact.leecat.co.kr  (separate cookie hostname)
//   internal  : 127.0.0.1:3412  (reverse-proxied by the nginx-proxy container)
const path = require('node:path');

const AGENT_TMP = '/workspace/.tmp/agent/sceneboard-artifact-dev';
const MONOREPO_ROOT = path.resolve(__dirname, '../../..');
const ARTIFACT_RUNTIME_ROOT = path.join(MONOREPO_ROOT, 'packages/artifact-runtime');

module.exports = {
  apps: [
    {
      name: 'sceneboard-artifact-runtime',
      script: path.join(ARTIFACT_RUNTIME_ROOT, 'deploy/launch-dev-runtime.sh'),
      interpreter: 'bash',
      cwd: MONOREPO_ROOT,
      autorestart: true,
      max_restarts: 15,
      min_uptime: '20s',
      restart_delay: 4000,
      env: {
        APP_ENV: 'staging',
        PORT: '3412',
        ARTIFACT_RUNTIME_LISTEN_HOST: '127.0.0.1',
        ARTIFACT_RUNTIME_APP_ORIGIN: 'https://sceneboard.leecat.co.kr',
        ARTIFACT_RUNTIME_API_ORIGIN: 'https://sceneboard.leecat.co.kr',
        ARTIFACT_RUNTIME_ORIGIN: 'https://sceneboard-artifact.leecat.co.kr',
        ARTIFACT_RUNTIME_PUBLIC_DIR: path.join(ARTIFACT_RUNTIME_ROOT, 'dist/public'),
        ARTIFACT_RUNTIME_EVIDENCE_FILE: `${AGENT_TMP}/evidence.v2.json`,
        ARTIFACT_RUNTIME_FRONTEND_RESOLVED_INPUT_FILE: `${AGENT_TMP}/frontend.json`,
        ARTIFACT_RUNTIME_BACKEND_RESOLVED_INPUT_FILE: `${AGENT_TMP}/backend.json`,
        ARTIFACT_RUNTIME_RESOLVED_INPUT_FILE: `${AGENT_TMP}/runtime.json`,
      },
      error_file: `${AGENT_TMP}/pm2-err.log`,
      out_file: `${AGENT_TMP}/pm2-out.log`,
      merge_logs: true,
    },
  ],
};
