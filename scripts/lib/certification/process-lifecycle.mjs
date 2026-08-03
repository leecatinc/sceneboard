import { spawn } from 'node:child_process';
import { CertificationError } from './canonical-json.mjs';
import { assertSafeCommand } from './safe-command-policy.mjs';

const launchEnvironmentKeys = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'NO_COLOR',
  'XDG_CACHE_HOME',
]);
const runtimeInjectionEnvironment =
  /^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+)$/u;

export const createCertificationChildEnvironment = (
  source = {},
  { allowedKeys = [], overrides = {} } = {},
) => {
  const output = {};
  for (const key of [...launchEnvironmentKeys, ...allowedKeys]) {
    if (runtimeInjectionEnvironment.test(key)) continue;
    const value = source[key];
    if (typeof value === 'string') output[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      runtimeInjectionEnvironment.test(key) ||
      !/^[A-Z][A-Z0-9_]*$/u.test(key) ||
      typeof value !== 'string'
    )
      throw new CertificationError('CERTIFICATION_CHILD_ENVIRONMENT_INVALID');
    output[key] = value;
  }
  return output;
};

export const createGitCertificationEnvironment = (source = {}) =>
  createCertificationChildEnvironment(source, {
    overrides: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
    },
  });

const npmNetworkEnvironmentKeys = Object.freeze([
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
  'NPM_CONFIG_NOPROXY',
  'NPM_CONFIG_CAFILE',
  'npm_config_registry',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
  'npm_config_cafile',
]);

export const createNpmCertificationEnvironment = (source = {}, { network = false } = {}) =>
  createCertificationChildEnvironment(source, {
    allowedKeys: network ? npmNetworkEnvironmentKeys : [],
    overrides: {
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_GLOBALCONFIG: '/dev/null',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_FUND: 'false',
    },
  });

export class CertificationProcessSupervisor {
  #children = new Map();

  constructor({ workspaceRoot }) {
    this.workspaceRoot = workspaceRoot;
  }

  start({ id, command, args = [], env = {}, allowDependencyInstall = false }) {
    if (this.#children.has(id)) throw new CertificationError('PROCESS_OWNERSHIP_VIOLATION');
    assertSafeCommand({ command, args, workspaceRoot: this.workspaceRoot, allowDependencyInstall });
    const child = spawn(command, args, {
      cwd: this.workspaceRoot,
      env,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#children.set(id, child);
    child.once('exit', () => this.#children.delete(id));
    return child;
  }

  async stop(id, { signal = 'SIGTERM', timeoutMs = 5_000 } = {}) {
    const child = this.#children.get(id);
    if (!child) return;
    child.kill(signal);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const timedOut = new Promise((_, reject) =>
      setTimeout(() => reject(new CertificationError('PROCESS_TEARDOWN_FAILED')), timeoutMs),
    );
    await Promise.race([exited, timedOut]);
    this.#children.delete(id);
  }

  async stopAll() {
    for (const id of [...this.#children.keys()].reverse()) await this.stop(id);
    if (this.#children.size !== 0) throw new CertificationError('PROCESS_TEARDOWN_FAILED');
  }

  get activeIds() {
    return [...this.#children.keys()];
  }
}
