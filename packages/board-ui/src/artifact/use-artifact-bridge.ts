'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  ArtifactBridgeEndpointV1,
  ArtifactHostStateMachineV1,
  type ArtifactBridgeEnvelopeV1,
  type ArtifactBridgeMessageV1,
} from '@leecat-board/artifact-runtime/bridge';
import { decodeArtifactPackageV1 } from '@leecat-board/artifact-runtime/package';
import { OUTER_SANDBOX_TOKENS_V1 } from '@leecat-board/artifact-runtime/policy';

import type { ArtifactHostInputV1 } from './ports.js';

export type ArtifactHostPhaseV1 = 'loading' | 'handshaking' | 'active' | 'stopped' | 'blocked' | 'failed' | 'unsupported';
export type ArtifactBridgeViewV1 = {
  containerRef: RefObject<HTMLDivElement | null>;
  phase: ArtifactHostPhaseV1;
  correlationId: string | null;
  stop(): void;
};

type Waiter = {
  type: ArtifactBridgeMessageV1['type'];
  resolve(message: ArtifactBridgeMessageV1): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const canonicalOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.origin !== value || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new TypeError('artifact runtime origin is invalid');
  return value;
};

const sameManifest = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export const useArtifactBridgeV1 = (input: ArtifactHostInputV1): ArtifactBridgeViewV1 => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<ArtifactHostPhaseV1>('loading');
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [localStopEpoch, setLocalStopEpoch] = useState(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setLocalStopEpoch((value) => value + 1);
    setCorrelationId(null);
    setPhase('stopped');
  }, []);

  useEffect(() => {
    if (localStopEpoch > 0) return;
    if (input.runtime.status !== 'ready') {
      setPhase(input.runtime.status === 'blocked' ? 'blocked' : input.runtime.status === 'stopped' ? 'stopped' : 'failed');
      return;
    }
    const container = containerRef.current;
    if (container === null) return;
    if (!('credentialless' in HTMLIFrameElement.prototype)) {
      setPhase('unsupported');
      return;
    }
    const runtimeOrigin = canonicalOrigin(input.runtimeOrigin);
    if (runtimeOrigin === window.location.origin) {
      setPhase('unsupported');
      return;
    }
    const controller = new AbortController();
    const lifecycle = new ArtifactHostStateMachineV1();
    const waiters: Waiter[] = [];
    let endpoint: ArtifactBridgeEndpointV1 | null = null;
    let port: MessagePort | null = null;
    let frame: HTMLIFrameElement | null = null;
    let packageBytes: Uint8Array | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let watchdogDeadline: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const rejectWaiters = (error: Error): void => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };
    const cleanup = (reason: Extract<ArtifactBridgeMessageV1, { type: 'host.dispose' }>['reason'] = 'route_change'): void => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      if (watchdogTimer !== null) clearInterval(watchdogTimer);
      if (watchdogDeadline !== null) clearTimeout(watchdogDeadline);
      rejectWaiters(new TypeError('artifact host disposed'));
      if (endpoint !== null && port !== null && !endpoint.closed) {
        try { port.postMessage(endpoint.send({ type: 'host.dispose', reason })); } catch { /* terminal */ }
      }
      endpoint?.close();
      port?.close();
      frame?.remove();
      if (packageBytes !== null) packageBytes.fill(0);
      packageBytes = null;
    };
    cleanupRef.current = () => cleanup('user_stop');

    const waitFor = (type: ArtifactBridgeMessageV1['type'], milliseconds: number): Promise<ArtifactBridgeMessageV1> => new Promise((resolve, reject) => {
      const waiter: Waiter = {
        type,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new TypeError(`artifact bridge timed out waiting for ${type}`));
        }, milliseconds),
      };
      waiters.push(waiter);
    });

    const run = async (): Promise<void> => {
      setPhase('loading');
      setCorrelationId(null);
      const admittedWatermark = input.snapshotWatermark;
      const metadata = await input.load.readMetadata({ boardId: input.boardId, artifact: input.artifact, signal: controller.signal });
      if (metadata.runtime.status !== 'ready') throw new TypeError('artifact metadata is not ready');
      packageBytes = await input.load.readPackage({ boardId: input.boardId, artifact: input.artifact, signal: controller.signal });
      const decoded = await decodeArtifactPackageV1(packageBytes);
      const confirmed = await input.load.readMetadata({ boardId: input.boardId, artifact: input.artifact, signal: controller.signal });
      if (input.snapshotWatermark < admittedWatermark
        || input.runtime.status !== 'ready'
        || confirmed.runtime.status !== 'ready'
        || decoded.manifest.artifact.artifactId !== input.artifact.artifactId
        || decoded.manifest.artifact.versionId !== input.artifact.versionId
        || !sameManifest(decoded.manifest, metadata.manifest)
        || !sameManifest(decoded.manifest, confirmed.manifest)) throw new TypeError('artifact loader cut did not certify');

      frame = document.createElement('iframe');
      frame.title = 'SceneBoard isolated artifact';
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('sandbox', OUTER_SANDBOX_TOKENS_V1);
      (frame as HTMLIFrameElement & { credentialless: boolean }).credentialless = true;
      frame.className = 'artifact-runtime-frame';
      const loaded = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TypeError('artifact runner navigation timed out')), 5_000);
        frame?.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
        frame?.addEventListener('error', () => { clearTimeout(timer); reject(new TypeError('artifact runner navigation failed')); }, { once: true });
      });
      container.replaceChildren(frame);
      frame.src = `${runtimeOrigin}/runner`;
      await loaded;
      if (frame.contentWindow === null) throw new TypeError('artifact runner window is unavailable');

      const channelId = randomId();
      const sessionId = randomId();
      const policyEpoch = randomId();
      endpoint = new ArtifactBridgeEndpointV1({ channelId, sessionId, artifact: input.artifact });
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event: MessageEvent<ArtifactBridgeEnvelopeV1>) => {
        try {
          if (endpoint === null) throw new TypeError('artifact endpoint is unavailable');
          const message = endpoint.receive(event.data).envelope.message;
          if (message.type === 'runner.watchdog.pong') {
            if (watchdogDeadline !== null) clearTimeout(watchdogDeadline);
            watchdogDeadline = null;
            return;
          }
          const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
          if (waiterIndex < 0) throw new TypeError('artifact runner sent an unexpected message');
          const [waiter] = waiters.splice(waiterIndex, 1);
          if (waiter === undefined) throw new TypeError('artifact waiter disappeared');
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } catch (error) {
          rejectWaiters(error instanceof Error ? error : new TypeError('artifact bridge failed'));
          cleanup('protocol_error');
          setCorrelationId(randomId());
          setPhase('failed');
        }
      };
      const bootstrap = endpoint.send({
        type: 'host.bootstrap',
        appOrigin: window.location.origin,
        runtimeOrigin,
        policyEpoch,
      }, { messagePorts: 1, arrayBufferBytes: [] });
      lifecycle.advance('mount');
      frame.contentWindow.postMessage(bootstrap, '*', [channel.port2]);
      port.start();
      await waitFor('runner.ready', 5_000);
      lifecycle.advance('runner.ready');

      const transferId = randomId();
      const chunkBytes = 262_144 as const;
      const chunkCount = Math.ceil(packageBytes.byteLength / chunkBytes);
      const start = endpoint.send({
        type: 'host.package.start',
        transferId,
        totalBytes: packageBytes.byteLength,
        chunkBytes,
        chunkCount,
        manifestSha256: decoded.manifestSha256,
        packageSha256: decoded.packageSha256,
      });
      port.postMessage(start);
      lifecycle.advance('package.start');
      let offset = 0;
      for (let index = 0; index < chunkCount; index += 1) {
        const length = Math.min(chunkBytes, packageBytes.byteLength - offset);
        const chunk = new Uint8Array(length);
        chunk.set(packageBytes.subarray(offset, offset + length));
        const envelope = endpoint.send({ type: 'host.package.chunk', transferId, index, offset, byteLength: length }, { messagePorts: 0, arrayBufferBytes: [length] });
        port.postMessage({ envelope, binary: chunk.buffer }, [chunk.buffer]);
        const ack = await waitFor('runner.package.ack', 5_000);
        if (ack.type !== 'runner.package.ack' || ack.transferId !== transferId || ack.index !== index || ack.receivedBytes !== offset + length) throw new TypeError('artifact package ACK mismatch');
        offset += length;
      }
      port.postMessage(endpoint.send({ type: 'host.package.end', transferId, chunkCount, totalBytes: packageBytes.byteLength, packageSha256: decoded.packageSha256 }));
      const ready = await waitFor('runner.package.ready', 10_000);
      if (ready.type !== 'runner.package.ready' || ready.transferId !== transferId || ready.packageSha256 !== decoded.packageSha256) throw new TypeError('artifact package-ready mismatch');
      lifecycle.advance('package.ready');
      lifecycle.advance('inner.start');
      setPhase('handshaking');
      await waitFor('artifact.ready', 10_000);
      lifecycle.advance('artifact.ready');
      packageBytes.fill(0);
      packageBytes = null;
      setPhase('active');
      watchdogTimer = setInterval(() => {
        if (endpoint === null || port === null || watchdogDeadline !== null || stopped) return;
        const watchdogId = randomId();
        port.postMessage(endpoint.send({ type: 'host.watchdog.ping', watchdogId, sentAtMonotonicMs: performance.now() }));
        watchdogDeadline = setTimeout(() => {
          watchdogDeadline = null;
          cleanup('timeout');
          setCorrelationId(randomId());
          setPhase('failed');
        }, 2_500);
      }, 1_000);
    };

    void run().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      cleanup('protocol_error');
      setCorrelationId(randomId());
      setPhase(error instanceof TypeError && error.message.includes('credential') ? 'unsupported' : 'failed');
    });
    return () => {
      cleanup('route_change');
      cleanupRef.current = null;
    };
  }, [
    input.artifact.artifactId,
    input.artifact.versionId,
    input.boardId,
    input.load,
    input.routeEpoch,
    input.runtime.status,
    input.runtimeOrigin,
    input.snapshotWatermark,
    localStopEpoch,
  ]);

  return { containerRef, phase, correlationId, stop };
};
