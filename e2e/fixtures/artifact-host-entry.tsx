import React, { useMemo, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { ArtifactHost, type ArtifactViewModeV1 } from '../../packages/board-ui/src/artifact/index.js';
import { BoardViewModeControls } from '../../leecat-board-nextjs/components/board/BoardViewModeControls.js';
import { I18nProvider } from '../../leecat-board-nextjs/components/i18n/I18nProvider.js';
import {
  canResetArtifactViewV1,
  createArtifactViewRegistryV1,
  reduceArtifactViewRegistryV1,
  selectedArtifactZoomV1,
} from '../../leecat-board-nextjs/lib/board/artifact-view-registry.js';

declare global {
  interface Window {
    __artifactFixture: Readonly<{ runtimeOrigin: string; packageBase64: string; manifest: unknown }>;
    __artifactHostHarness?: Readonly<{
      mode(mode: ArtifactViewModeV1): void;
      callbackVersion(version: number): void;
      stop(): void;
      reset(): void;
      unmount(): void;
      snapshot(): unknown;
    }>;
  }
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new TypeError('artifact host fixture root is unavailable');
const packageBytes = Uint8Array.from(atob(window.__artifactFixture.packageBase64), (value) => value.charCodeAt(0));
const artifact = { artifactId: 'artifact_one', versionId: 'version_one' } as const;
const runtime = { artifact, status: 'ready' as const, updatedAt: '2026-07-20T00:00:00.000Z', failure: null };
const load = {
  readMetadata: async () => ({ manifest: window.__artifactFixture.manifest as never, runtime }),
  readPackage: async () => packageBytes.slice(),
};
const root = createRoot(rootElement);
const viewEvents: unknown[] = [];
const navigationEvents: unknown[] = [];
const resizeEvents: unknown[] = [];
let setMode: ((mode: ArtifactViewModeV1) => void) | null = null;
let setCallbackVersion: ((version: number) => void) | null = null;
let stopHost: (() => void) | null = null;
let resetView: (() => void) | null = null;

function Fixture() {
  const [mode, updateMode] = useState<ArtifactViewModeV1>('actual');
  const [callbackVersion, updateCallbackVersion] = useState(0);
  const [stopSignal, setStopSignal] = useState(0);
  const [registry, dispatchRegistry] = useReducer(reduceArtifactViewRegistryV1, undefined, createArtifactViewRegistryV1);
  setMode = updateMode;
  setCallbackVersion = updateCallbackVersion;
  stopHost = () => setStopSignal((value) => value + 1);
  resetView = () => dispatchRegistry({ type: 'reset' });
  const resetCommand = useMemo(() => registry.resetCommand, [registry.resetCommand]);
  return (
    <I18nProvider initialLocale="en">
      <BoardViewModeControls
        value={mode}
        zoom={selectedArtifactZoomV1(registry)}
        canReset={canResetArtifactViewV1(registry)}
        onChange={updateMode}
        onReset={() => dispatchRegistry({ type: 'reset' })}
      />
      <ArtifactHost
        boardId="board_one"
        artifact={artifact}
        runtime={runtime}
        runtimeOrigin={window.__artifactFixture.runtimeOrigin}
        routeEpoch="route_one"
        hostInstanceId="artifact_node"
        incarnationKey="route_one:artifact_node:artifact_one:version_one"
        snapshotWatermark={1}
        load={load}
        viewMode={mode}
        stopSignal={stopSignal}
        resetCommand={resetCommand}
        onViewStateChange={(event) => {
          viewEvents.push(event);
          dispatchRegistry({ type: 'event', event });
          if (event.phase === 'interaction') throw new TypeError('fixture consumer failure');
        }}
        onNavigationIntent={(intent) => {
          navigationEvents.push({ version: callbackVersion, intent });
          throw new TypeError('fixture consumer failure');
        }}
        onResizeRequest={(request) => {
          resizeEvents.push({ version: callbackVersion, ...request });
          throw new TypeError('fixture consumer failure');
        }}
      />
    </I18nProvider>
  );
}

flushSync(() => root.render(<Fixture />));

window.__artifactHostHarness = Object.freeze({
  mode(mode) {
    if (setMode === null) throw new TypeError('artifact host mode setter is unavailable');
    flushSync(() => setMode?.(mode));
  },
  callbackVersion(version) {
    if (setCallbackVersion === null) throw new TypeError('artifact host callback-version setter is unavailable');
    flushSync(() => setCallbackVersion?.(version));
  },
  stop() {
    if (stopHost === null) throw new TypeError('artifact host stop setter is unavailable');
    flushSync(() => stopHost?.());
  },
  reset() {
    if (resetView === null) throw new TypeError('artifact host reset setter is unavailable');
    flushSync(() => resetView?.());
  },
  unmount() { flushSync(() => root.unmount()); },
  snapshot() {
    const container = document.querySelector<HTMLElement>('.artifact-frame-container');
    const stage = container?.querySelector<HTMLElement>('.artifact-runtime-stage');
    const transform = container?.querySelector<HTMLElement>('.artifact-runtime-transform');
    const frame = container?.querySelector<HTMLIFrameElement>('.artifact-runtime-frame');
    return {
      phase: document.querySelector('.artifact-host')?.className ?? null,
      children: container?.childElementCount ?? -1,
      mode: container?.dataset.viewMode ?? null,
      zoom: container?.dataset.zoomPercent ?? null,
      panning: container?.dataset.panning ?? null,
      scrollLeft: container?.scrollLeft ?? -1,
      scrollTop: container?.scrollTop ?? -1,
      stageWidth: stage?.style.width ?? null,
      stageHeight: stage?.style.height ?? null,
      transform: transform?.style.transform ?? null,
      frameTitle: frame?.title ?? null,
      controls: document.querySelector('.board-view-modes')?.textContent ?? null,
      viewEvents: [...viewEvents],
      navigationEvents: [...navigationEvents],
      resizeEvents: [...resizeEvents],
    };
  },
});
