import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { useArtifactBridgeV1 } from '../../packages/board-ui/src/artifact/index.js';

declare global {
  interface Window {
    __artifactFixture: Readonly<{ runtimeOrigin: string; packageBase64: string; manifest: unknown }>;
    __artifactBridgeHarness?: Readonly<{
      snapshot(): unknown;
      stop(): void;
      callbackVersion(version: number): void;
      viewMode(mode: 'fit-height' | 'actual'): void;
      rememberFrame(): void;
      frameStable(): boolean;
    }>;
  }
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new TypeError('artifact bridge fixture root is unavailable');
const packageBytes = Uint8Array.from(atob(window.__artifactFixture.packageBase64), (value) => value.charCodeAt(0));
const artifact = { artifactId: 'artifact_one', versionId: 'version_one' } as const;
const runtime = { artifact, status: 'ready' as const, updatedAt: '2026-07-20T00:00:00.000Z', failure: null };
const load = {
  readMetadata: async () => ({ manifest: window.__artifactFixture.manifest as never, runtime }),
  readPackage: async () => packageBytes.slice(),
};
const timeline: unknown[] = [];
const resizeEvents: unknown[] = [];
const navigationEvents: unknown[] = [];
let renderCount = 0;
let latestView: ReturnType<typeof useArtifactBridgeV1> | null = null;
let updateCallbackVersion: ((version: number) => void) | null = null;
let updateViewMode: ((mode: 'fit-height' | 'actual') => void) | null = null;
let rememberedFrame: HTMLIFrameElement | null = null;

function Fixture() {
  renderCount += 1;
  const [callbackVersion, setCallbackVersion] = useState(0);
  const [viewMode, setViewMode] = useState<'fit-height' | 'actual'>('actual');
  updateCallbackVersion = setCallbackVersion;
  updateViewMode = setViewMode;
  const bridge = useArtifactBridgeV1({
    boardId: 'board_one',
    artifact,
    runtime,
    runtimeOrigin: window.__artifactFixture.runtimeOrigin,
    routeEpoch: 'route_one',
    hostInstanceId: 'artifact_node',
    incarnationKey: 'route_one:artifact_node:artifact_one:version_one',
    snapshotWatermark: 1,
    load,
    viewMode,
    onResizeRequest: (value) => resizeEvents.push({ version: callbackVersion, phase: bridge.phase, renderCount, value }),
    onNavigationIntent: (intent) => navigationEvents.push({ version: callbackVersion, intent }),
  });
  latestView = bridge;
  useEffect(() => {
    timeline.push({ phase: bridge.phase, contentSize: bridge.contentSize, renderCount });
  }, [bridge.contentSize, bridge.phase]);
  return <div ref={bridge.containerRef} className="artifact-frame-container" />;
}

const root = createRoot(rootElement);
flushSync(() => root.render(<Fixture />));

window.__artifactBridgeHarness = Object.freeze({
  snapshot() {
    return {
      phase: latestView?.phase ?? null,
      contentSize: latestView?.contentSize ?? null,
      renderCount,
      resizeEvents: [...resizeEvents],
      navigationEvents: [...navigationEvents],
      timeline: [...timeline],
      frames: document.querySelectorAll('iframe').length,
    };
  },
  stop() { latestView?.stop(); },
  callbackVersion(version) {
    if (updateCallbackVersion === null) throw new TypeError('artifact callback updater is unavailable');
    flushSync(() => updateCallbackVersion?.(version));
  },
  viewMode(mode) {
    if (updateViewMode === null) throw new TypeError('artifact view-mode updater is unavailable');
    flushSync(() => updateViewMode?.(mode));
  },
  rememberFrame() { rememberedFrame = document.querySelector('iframe'); },
  frameStable() { return rememberedFrame !== null && rememberedFrame === document.querySelector('iframe'); },
});
