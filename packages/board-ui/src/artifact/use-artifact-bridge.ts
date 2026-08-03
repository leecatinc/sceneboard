'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  ArtifactBridgeEndpointV1,
  ArtifactHostStateMachineV1,
  type ArtifactBridgeEnvelopeV1,
  type ArtifactBridgeMessageV1,
  type ArtifactNavigationIntentV1,
} from '@sceneboard/artifact-runtime/bridge';
import { decodeArtifactPackageV1 } from '@sceneboard/artifact-runtime/package';
import { OUTER_SANDBOX_TOKENS_V1 } from '@sceneboard/artifact-runtime/policy';

import type { ArtifactHostInputV1 } from './ports.js';
import { dispatchArtifactNavigationIntentV1 } from './navigation-dispatch.js';

export type ArtifactHostPhaseV1 =
  | 'loading'
  | 'handshaking'
  | 'active'
  | 'stopped'
  | 'blocked'
  | 'failed'
  | 'unsupported';
export type ArtifactBridgeViewV1 = {
  containerRef: RefObject<HTMLDivElement | null>;
  phase: ArtifactHostPhaseV1;
  correlationId: string | null;
  contentSize: Readonly<{ width: number; height: number }> | null;
  stop(): void;
};

type Waiter = {
  type: ArtifactBridgeMessageV1['type'];
  resolve(message: ArtifactBridgeMessageV1): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type BinaryCarrier = { envelope: ArtifactBridgeEnvelopeV1; binary: ArrayBuffer };

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const canonicalOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.origin !== value || url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new TypeError('artifact runtime origin is invalid');
  return value;
};

const sameManifest = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const useArtifactBridgeV1 = (input: ArtifactHostInputV1): ArtifactBridgeViewV1 => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<ArtifactHostPhaseV1>('loading');
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [contentSize, setContentSize] = useState<Readonly<{
    width: number;
    height: number;
  }> | null>(null);
  const [localStopEpoch, setLocalStopEpoch] = useState(0);
  const cleanupRef = useRef<(() => void) | null>(null);
  const sendNavigationControlRef = useRef<((enabled: boolean) => void) | null>(null);
  const onNavigationIntentRef = useRef(input.onNavigationIntent);
  const onResizeRequestRef = useRef(input.onResizeRequest);
  const viewModeRef = useRef(input.viewMode ?? 'fit-page');
  onNavigationIntentRef.current = input.onNavigationIntent;
  onResizeRequestRef.current = input.onResizeRequest;
  viewModeRef.current = input.viewMode ?? 'fit-page';

  const stop = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setLocalStopEpoch((value) => value + 1);
    setCorrelationId(null);
    setContentSize(null);
    setPhase('stopped');
  }, []);

  useEffect(() => {
    if (phase !== 'active') return;
    sendNavigationControlRef.current?.(input.viewMode === 'actual');
  }, [input.viewMode, phase]);

  useEffect(() => {
    if (localStopEpoch > 0) return;
    if (input.runtime.status !== 'ready') {
      setPhase(
        input.runtime.status === 'blocked'
          ? 'blocked'
          : input.runtime.status === 'stopped'
            ? 'stopped'
            : 'failed',
      );
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
    let navigationTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const releasePackage = (): void => {
      if (packageBytes === null) return;
      if (input.load.releasePackage === undefined) packageBytes.fill(0);
      else input.load.releasePackage(packageBytes);
      packageBytes = null;
    };

    const assertRunning = (): void => {
      if (stopped || controller.signal.aborted)
        throw new TypeError('artifact host run was superseded');
    };

    const rejectWaiters = (error: Error): void => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };
    const cleanup = (
      reason: Extract<ArtifactBridgeMessageV1, { type: 'host.dispose' }>['reason'] = 'route_change',
    ): void => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      if (watchdogTimer !== null) clearInterval(watchdogTimer);
      if (watchdogDeadline !== null) clearTimeout(watchdogDeadline);
      if (navigationTimer !== null) clearTimeout(navigationTimer);
      navigationTimer = null;
      rejectWaiters(new TypeError('artifact host disposed'));
      if (endpoint !== null && port !== null && !endpoint.closed) {
        try {
          port.postMessage(endpoint.send({ type: 'host.dispose', reason }));
        } catch {
          /* terminal */
        }
      }
      endpoint?.close();
      port?.close();
      frame?.remove();
      sendNavigationControlRef.current = null;
      setContentSize(null);
      releasePackage();
    };
    cleanupRef.current = () => cleanup('user_stop');

    const waitFor = (
      type: ArtifactBridgeMessageV1['type'],
      milliseconds: number,
    ): Promise<ArtifactBridgeMessageV1> =>
      new Promise((resolve, reject) => {
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
      setContentSize(null);
      const admittedWatermark = input.snapshotWatermark;
      const metadata = await input.load.readMetadata({
        boardId: input.boardId,
        artifact: input.artifact,
        signal: controller.signal,
      });
      assertRunning();
      if (metadata.runtime.status !== 'ready')
        throw new TypeError('artifact metadata is not ready');
      packageBytes = await input.load.readPackage({
        boardId: input.boardId,
        artifact: input.artifact,
        signal: controller.signal,
      });
      assertRunning();
      const decoded = await decodeArtifactPackageV1(packageBytes);
      assertRunning();
      const confirmed = await input.load.readMetadata({
        boardId: input.boardId,
        artifact: input.artifact,
        signal: controller.signal,
      });
      assertRunning();
      if (
        input.snapshotWatermark < admittedWatermark ||
        input.runtime.status !== 'ready' ||
        confirmed.runtime.status !== 'ready' ||
        decoded.manifest.artifact.artifactId !== input.artifact.artifactId ||
        decoded.manifest.artifact.versionId !== input.artifact.versionId ||
        !sameManifest(decoded.manifest, metadata.manifest) ||
        !sameManifest(decoded.manifest, confirmed.manifest)
      )
        throw new TypeError('artifact loader cut did not certify');

      frame = document.createElement('iframe');
      frame.title = 'SceneBoard isolated artifact';
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('sandbox', OUTER_SANDBOX_TOKENS_V1);
      (frame as HTMLIFrameElement & { credentialless: boolean }).credentialless = true;
      frame.className = 'artifact-runtime-frame';
      frame.src = `${runtimeOrigin}/runner`;
      const loaded = new Promise<void>((resolve, reject) => {
        navigationTimer = setTimeout(() => {
          navigationTimer = null;
          reject(new TypeError('artifact runner navigation timed out'));
        }, 5_000);
        frame?.addEventListener(
          'load',
          () => {
            if (navigationTimer !== null) clearTimeout(navigationTimer);
            navigationTimer = null;
            resolve();
          },
          { once: true },
        );
        frame?.addEventListener(
          'error',
          () => {
            if (navigationTimer !== null) clearTimeout(navigationTimer);
            navigationTimer = null;
            reject(new TypeError('artifact runner navigation failed'));
          },
          { once: true },
        );
      });
      const stage = document.createElement('div');
      stage.className = 'artifact-runtime-stage';
      const transformPlane = document.createElement('div');
      transformPlane.className = 'artifact-runtime-transform';
      transformPlane.append(frame);
      stage.append(transformPlane);
      container.replaceChildren(stage);
      await loaded;
      assertRunning();
      if (frame.contentWindow === null)
        throw new TypeError('artifact runner window is unavailable');

      const channelId = randomId();
      const sessionId = randomId();
      const policyEpoch = randomId();
      endpoint = new ArtifactBridgeEndpointV1({ channelId, sessionId, artifact: input.artifact });
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event: MessageEvent<ArtifactBridgeEnvelopeV1 | BinaryCarrier>) => {
        try {
          if (endpoint === null) throw new TypeError('artifact endpoint is unavailable');
          let source: unknown = event.data;
          let binary: ArrayBuffer | null = null;
          let transfers = { messagePorts: event.ports.length, arrayBufferBytes: [] as number[] };
          if (
            event.data !== null &&
            typeof event.data === 'object' &&
            !Array.isArray(event.data) &&
            Object.keys(event.data).length === 2 &&
            Object.hasOwn(event.data, 'envelope') &&
            Object.hasOwn(event.data, 'binary')
          ) {
            const carrier = event.data as BinaryCarrier;
            if (!(carrier.binary instanceof ArrayBuffer))
              throw new TypeError('binary carrier is invalid');
            source = carrier.envelope;
            binary = carrier.binary;
            transfers = { messagePorts: event.ports.length, arrayBufferBytes: [binary.byteLength] };
          }
          const message = endpoint.receive(source, transfers).envelope.message;
          if (message.type === 'runner.watchdog.pong') {
            if (watchdogDeadline !== null) clearTimeout(watchdogDeadline);
            watchdogDeadline = null;
            return;
          }
          if (message.type === 'artifact.resize.request') {
            onResizeRequestRef.current?.(message.value);
            return;
          }
          if (
            message.type === 'artifact.navigation.wheel' ||
            message.type === 'artifact.navigation.pan.start' ||
            message.type === 'artifact.navigation.pan.move' ||
            message.type === 'artifact.navigation.pan.end' ||
            message.type === 'artifact.navigation.pan.cancel'
          ) {
            dispatchArtifactNavigationIntentV1(
              viewModeRef.current,
              message as ArtifactNavigationIntentV1,
              onNavigationIntentRef.current,
            );
            return;
          }
          if (
            message.type === 'artifact.selection.change' ||
            message.type === 'artifact.user-action' ||
            message.type === 'artifact.capability.request'
          ) {
            if (binary !== null) new Uint8Array(binary).fill(0);
            return;
          }
          const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
          if (waiterIndex < 0) throw new TypeError('artifact runner sent an unexpected message');
          const [waiter] = waiters.splice(waiterIndex, 1);
          if (waiter === undefined) throw new TypeError('artifact waiter disappeared');
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } catch (error) {
          for (const sink of [
            'DOM',
            'BROWSER_STORAGE_CACHE_OR_SERVICE_WORKER',
            'SCREENSHOT_TRACE_OR_VIDEO',
          ] as const) {
            endpoint?.rejectSecretSink(sink, error, { observe: () => {} });
          }
          rejectWaiters(error instanceof Error ? error : new TypeError('artifact bridge failed'));
          cleanup('protocol_error');
          setCorrelationId(randomId());
          setPhase('failed');
        }
      };
      const bootstrap = endpoint.send(
        {
          type: 'host.bootstrap',
          appOrigin: window.location.origin,
          runtimeOrigin,
          policyEpoch,
        },
        { messagePorts: 1, arrayBufferBytes: [] },
      );
      lifecycle.advance('mount');
      frame.contentWindow.postMessage(bootstrap, '*', [channel.port2]);
      port.start();
      sendNavigationControlRef.current = (enabled) => {
        if (endpoint === null || port === null || stopped) return;
        port.postMessage(endpoint.send({ type: 'host.navigation.set', enabled }));
      };
      await waitFor('runner.ready', 5_000);
      assertRunning();
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
        const envelope = endpoint.send(
          { type: 'host.package.chunk', transferId, index, offset, byteLength: length },
          { messagePorts: 0, arrayBufferBytes: [length] },
        );
        port.postMessage({ envelope, binary: chunk.buffer }, [chunk.buffer]);
        const ack = await waitFor('runner.package.ack', 5_000);
        assertRunning();
        if (
          ack.type !== 'runner.package.ack' ||
          ack.transferId !== transferId ||
          ack.index !== index ||
          ack.receivedBytes !== offset + length
        )
          throw new TypeError('artifact package ACK mismatch');
        offset += length;
      }
      port.postMessage(
        endpoint.send({
          type: 'host.package.end',
          transferId,
          chunkCount,
          totalBytes: packageBytes.byteLength,
          packageSha256: decoded.packageSha256,
        }),
      );
      const ready = await waitFor('runner.package.ready', 10_000);
      assertRunning();
      if (
        ready.type !== 'runner.package.ready' ||
        ready.transferId !== transferId ||
        ready.packageSha256 !== decoded.packageSha256
      )
        throw new TypeError('artifact package-ready mismatch');
      lifecycle.advance('package.ready');
      lifecycle.advance('inner.start');
      setPhase('handshaking');
      await waitFor('artifact.ready', 10_000);
      assertRunning();
      lifecycle.advance('artifact.ready');
      releasePackage();
      setContentSize({ width: 1_200, height: 675 });
      setPhase('active');
      watchdogTimer = setInterval(() => {
        if (endpoint === null || port === null || watchdogDeadline !== null || stopped) return;
        const watchdogId = randomId();
        port.postMessage(
          endpoint.send({
            type: 'host.watchdog.ping',
            watchdogId,
            sentAtMonotonicMs: performance.now(),
          }),
        );
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
      setPhase(
        error instanceof TypeError && error.message.includes('credential')
          ? 'unsupported'
          : 'failed',
      );
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

  return { containerRef, phase, correlationId, contentSize, stop };
};
