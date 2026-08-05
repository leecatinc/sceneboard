import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('public presentation chooser exposes start and join without inferring presenter authority', () => {
  const dialog = source('app/s/[shareToken]/public-presentation-session-dialog.tsx');
  assert.match(dialog, /role="dialog"/u);
  assert.match(dialog, /aria-modal="true"/u);
  assert.match(dialog, /presentation\.startNewSession/u);
  assert.match(dialog, /presentation\.joinActiveSession/u);
  assert.match(dialog, /onJoin\(session\.sessionId\)/u);
  assert.doesNotMatch(dialog, /role:\s*['"]presenter/u);
});

test('public presentation binds viewer state to SSE and streams bounded presenter annotations', () => {
  const client = source('app/s/[shareToken]/shared-board-client.tsx');
  assert.match(client, /new EventSource\(/u);
  assert.match(client, /withCredentials:\s*true/u);
  assert.match(client, /next\.version < active\.version/u);
  assert.match(client, /livePresentation\?\.role === 'viewer'/u);
  assert.match(
    client,
    /navigationDisabled=\{presentationActive && livePresentation\?\.role === 'viewer'\}/u,
  );
  assert.match(client, /updatePublicPresentationSessionV1/u);
  assert.match(client, /expectedVersion/u);
  assert.match(client, /const PRESENTATION_UPDATE_INTERVAL_MS = 125/u);
  assert.match(client, /delivery: PresentationAnnotationDeliveryV1/u);
  assert.match(client, /pendingPresentationUpdateRef\.current = \{ pageId, strokes, delivery \}/u);
  assert.match(
    client,
    /delivery === 'transient' && !Number\.isFinite\(elapsed\)[\s\S]*?PRESENTATION_UPDATE_INTERVAL_MS[\s\S]*?Math\.max\(0, PRESENTATION_UPDATE_INTERVAL_MS - elapsed\)/u,
  );
  assert.match(
    client,
    /presentationUpdateTimerRef\.current !== null[\s\S]*?return;[\s\S]*?presentationUpdateTimerRef\.current = setTimeout/u,
  );
  assert.match(
    client,
    /delivery === 'final' && presentationUpdateTimerRef\.current !== null[\s\S]*?clearTimeout/u,
  );
  assert.match(
    client,
    /presentationUpdateInFlightRef\.current = false;[\s\S]*?schedulePresentationUpdateRef\.current\(nextPending\.delivery\)/u,
  );
  assert.doesNotMatch(client, /queueMicrotask\(\(\) => flushPresentationUpdateRef/u);
  assert.doesNotMatch(client, /key=\{[^}]*livePresentation/u);
});

test('annotation layer switches tools without resetting its per-page history', () => {
  const layer = source('components/board/PresentationAnnotationLayer.tsx');
  const selectionStart = layer.indexOf('const selectTool');
  const selection = layer.slice(selectionStart, layer.indexOf('if (!active)', selectionStart));
  assert.match(selection, /finishGesture/u);
  assert.match(selection, /setTool\(next\)/u);
  assert.doesNotMatch(selection, /clear\(|createPresentationAnnotationHistoryV1/u);
  assert.match(layer, /readOnly\s*\n\s*\? externalStrokes/u);
});

test('annotation layer classifies active projections as transient and committed state as final', () => {
  const layer = source('components/board/PresentationAnnotationLayer.tsx');
  assert.match(
    layer,
    /onVisibleStateChange\?\.\(history\.present, gestureRef\.current === null \? 'final' : 'transient'\)/u,
  );
  assert.match(
    layer,
    /onVisibleStateChange\?\.\(\[\.\.\.historyRef\.current\.present, draftStroke\], 'transient'\)/u,
  );
  assert.match(layer, /onPointerCancel=\{\(event\) => \{[\s\S]*?finishGesture\(false\)/u);
});
