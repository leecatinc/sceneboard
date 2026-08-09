import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BoardSnapshotParserV1, type BoardSnapshotV1 } from '@sceneboard/board-schema';
import { renderToStaticMarkup } from 'react-dom/server';

import { ArtifactHost, type ArtifactLoadPortV1 } from '../../src/artifact/index.js';
import { BoardRenderer } from '../../src/renderer/index.js';
import { rendererTestInputV2 } from '../renderer-test-input.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../../board-schema/test/fixtures/valid/${name}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;

const snapshot = (): BoardSnapshotV1 => {
  const base = fixture('snapshot-board.v1.json') as Record<string, unknown>;
  const parsed = BoardSnapshotParserV1.parse({
    ...base,
    scene: fixture('scene-all-node-types.v1.json'),
    hitl: [fixture('hitl-interaction-open.v1.json')],
    artifacts: [fixture('artifact-runtime-summary-ready.v1.json')],
  });
  if (!parsed.ok) throw new TypeError('artifact snapshot fixture is invalid');
  return parsed.data.value;
};

test('D5 placeholder delegates only the exact content.artifact node to D7 host ownership', () => {
  const html = renderToStaticMarkup(
    <BoardRenderer
      {...rendererTestInputV2(snapshot())}
      renderArtifact={({ node }) => (
        <div data-artifact-host={`${node.artifact.artifactId}:${node.artifact.versionId}`}>
          D7 host
        </div>
      )}
    />,
  );
  assert.match(html, /data-artifact-host=/u);
  assert.match(html, />D7 host</u);
  assert.doesNotMatch(html, /execution disabled/u);
});

test('ArtifactHost server shell is trusted, frame-free, and keeps local stop visible', () => {
  const current = snapshot();
  const runtime = current.artifacts[0];
  assert.ok(runtime);
  const load: ArtifactLoadPortV1 = {
    readMetadata: async () => {
      throw new TypeError('not called during server render');
    },
    readPackage: async () => {
      throw new TypeError('not called during server render');
    },
  };
  const html = renderToStaticMarkup(
    <ArtifactHost
      boardId={current.boardId}
      artifact={runtime.artifact}
      runtime={runtime}
      runtimeOrigin="http://127.0.0.2:3412"
      routeEpoch="route_one"
      hostInstanceId="artifact_node"
      incarnationKey={`route_one:artifact_node:${runtime.artifact.artifactId}:${runtime.artifact.versionId}`}
      snapshotWatermark={current.lastEventSequence}
      load={load}
    />,
  );
  assert.match(html, /Preparing the isolated artifact/u);
  assert.match(html, /Stop rendering/u);
  assert.doesNotMatch(html, /<iframe|srcdoc|dangerouslySetInnerHTML/u);
});

test('artifact host sources use one credentialless allow-scripts outer frame', () => {
  const source = readFileSync(
    new URL('../../src/artifact/use-artifact-bridge.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /credentialless = true/u);
  assert.match(source, /setAttribute\('sandbox', OUTER_SANDBOX_TOKENS_V1\)/u);
  assert.match(source, /postMessage\(bootstrap, '\*', \[channel\.port2\]\)/u);
  assert.doesNotMatch(source, /srcdoc|dangerouslySetInnerHTML|eval\(|new Function/u);
});

test('ArtifactHost rejects an invalid incarnation before mounting the admitted bridge host', () => {
  const current = snapshot();
  const runtime = current.artifacts[0];
  assert.ok(runtime);
  const load: ArtifactLoadPortV1 = {
    readMetadata: async () => {
      throw new TypeError('invalid identity must not load metadata');
    },
    readPackage: async () => {
      throw new TypeError('invalid identity must not load a package');
    },
  };
  const html = renderToStaticMarkup(
    <ArtifactHost
      boardId={current.boardId}
      artifact={runtime.artifact}
      runtime={runtime}
      runtimeOrigin="http://127.0.0.2:3412"
      routeEpoch="route_one"
      hostInstanceId="artifact_node"
      incarnationKey="route_one:different_node:different_artifact:different_version"
      snapshotWatermark={current.lastEventSequence}
      load={load}
    />,
  );
  assert.match(html, /could not be rendered safely/u);
  assert.doesNotMatch(html, /Preparing the isolated artifact|Stop rendering|<iframe/u);
});

test('ArtifactHost source places identity admission before the bridge-owning child', () => {
  const source = readFileSync(
    new URL('../../src/artifact/ArtifactHost.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /function AdmittedArtifactHost/u);
  assert.match(source, /if \(!hasValidIdentity\)[\s\S]*return <AdmittedArtifactHost/u);
  assert.match(source, /container\.scrollLeft = 0/u);
  assert.match(source, /container\.scrollTop = 0/u);
  assert.match(source, /renderModeRef\.current === 'responsive-fixed-canvas'/u);
  assert.match(source, /size\.width \* renderScale\.viewportScale/u);
  assert.match(source, /frame\.style\.width = `\$\{viewportWidth\}px`/u);
  assert.match(source, /writeTransform\(next, renderScale\.compositorScale\)/u);
  assert.match(source, /frame\.style\.setProperty\('zoom', '1'\)[\s\S]*mode === 'actual'/u);
  assert.match(
    source,
    /mode === 'fill'[\s\S]*frame\.style\.width = `\$\{availableWidth\}px`[\s\S]*frame\.style\.height = `\$\{availableHeight\}px`[\s\S]*writeTransform\(\{ scale: 1, x: 0, y: 0 \}\)/u,
  );
});

test('ArtifactHost admits reset epochs only for its exact positive incarnation', () => {
  const source = readFileSync(
    new URL('../../src/artifact/ArtifactHost.tsx', import.meta.url),
    'utf8',
  );
  assert.equal(source.match(/advanceArtifactResetEpochV1\(/gu)?.length, 2);
  assert.match(source, /appliedResetEpochRef\.current = reset\.epoch/u);
  assert.doesNotMatch(source, /resetEpoch \?\? 0|appliedResetEpochRef\.current = 0/u);
  assert.match(source, /generation !== generationRef\.current/u);
  assert.match(source, /cancelAnimationFrame\(sizeFrameRef\.current\)/u);
  assert.match(source, /applyArtifactPanIntentV1\(isPanningRef\.current, intent\)/u);
  assert.match(
    source,
    /intent\.type === 'artifact\.navigation\.pan\.cancel'[\s\S]*delete container\.dataset\.panning/u,
  );
});
