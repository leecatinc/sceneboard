import { spawn } from 'node:child_process';
import { CertificationError } from './canonical-json.mjs';
import { assertSafeCommand } from './safe-command-policy.mjs';

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
      env: { ...process.env, ...env },
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
