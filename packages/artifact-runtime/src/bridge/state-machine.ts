import type { ArtifactBridgeMessageV1 } from './envelope.js';

export type ArtifactHostLifecycleStateV1 = 'idle' | 'outer_bootstrap' | 'runner_ready' | 'package_transfer' | 'outer_certified' | 'inner_handshake' | 'active' | 'disposing' | 'stopped' | 'failed';
export type ArtifactRunnerLifecycleStateV1 = 'bootstrap_wait' | 'ready' | 'receiving' | 'certified' | 'inner_handshake' | 'active' | 'disposing' | 'stopped' | 'failed';

export class ArtifactHostStateMachineV1 {
  #state: ArtifactHostLifecycleStateV1 = 'idle';

  get state(): ArtifactHostLifecycleStateV1 { return this.#state; }

  advance(event: 'mount' | 'runner.ready' | 'package.start' | 'package.ready' | 'inner.start' | 'artifact.ready' | 'dispose' | 'peer.disposed' | 'fail'): ArtifactHostLifecycleStateV1 {
    if (event === 'fail' && this.#state !== 'stopped') return (this.#state = 'failed');
    const next: Partial<Record<ArtifactHostLifecycleStateV1, Partial<Record<typeof event, ArtifactHostLifecycleStateV1>>>> = {
      idle: { mount: 'outer_bootstrap' },
      outer_bootstrap: { 'runner.ready': 'runner_ready', dispose: 'disposing' },
      runner_ready: { 'package.start': 'package_transfer', dispose: 'disposing' },
      package_transfer: { 'package.ready': 'outer_certified', dispose: 'disposing' },
      outer_certified: { 'inner.start': 'inner_handshake', dispose: 'disposing' },
      inner_handshake: { 'artifact.ready': 'active', dispose: 'disposing' },
      active: { dispose: 'disposing' },
      disposing: { 'peer.disposed': 'stopped' },
    };
    const result = next[this.#state]?.[event];
    if (result === undefined) throw new TypeError(`illegal host lifecycle edge: ${this.#state} -> ${event}`);
    this.#state = result;
    return result;
  }
}

export class ArtifactRunnerStateMachineV1 {
  #state: ArtifactRunnerLifecycleStateV1 = 'bootstrap_wait';

  get state(): ArtifactRunnerLifecycleStateV1 { return this.#state; }

  receive(type: ArtifactBridgeMessageV1['type']): ArtifactRunnerLifecycleStateV1 {
    if (type === 'protocol.error') return (this.#state = 'failed');
    if (type === 'host.dispose') return (this.#state = 'disposing');
    if (type === 'host.watchdog.ping' && ['ready', 'receiving', 'certified', 'inner_handshake', 'active'].includes(this.#state)) return this.#state;
    const next: Partial<Record<ArtifactRunnerLifecycleStateV1, Partial<Record<ArtifactBridgeMessageV1['type'], ArtifactRunnerLifecycleStateV1>>>> = {
      bootstrap_wait: { 'host.bootstrap': 'ready' },
      ready: { 'host.package.start': 'receiving' },
      receiving: { 'host.package.chunk': 'receiving', 'host.package.end': 'certified' },
      certified: { 'host.inner.init': 'inner_handshake' },
      inner_handshake: { 'artifact.ready': 'active' },
      disposing: { 'peer.disposed': 'stopped' },
    };
    const result = next[this.#state]?.[type];
    if (result === undefined) throw new TypeError(`illegal runner lifecycle message: ${this.#state} -> ${type}`);
    this.#state = result;
    return result;
  }
}
