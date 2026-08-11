import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('public route keeps the raw route secret inside the server entry and bound actions', () => {
  const page = source('app/s/[shareToken]/page.tsx');
  const actions = source('app/s/[shareToken]/shared-board-actions.ts');
  const client = source('app/s/[shareToken]/shared-board-client.tsx');
  assert.match(page, /bootstrapSharedBoard\.bind\(null, shareToken\)/u);
  assert.match(page, /submitSharedBoardPassword\.bind\(null, shareToken\)/u);
  assert.doesNotMatch(page, /await bootstrapSharedBoard\(shareToken\)/u);
  assert.match(client, /useEffect\(\(\) => \{[\s\S]*?bootstrapAction\(\)/u);
  assert.match(client, /initialBootstrapStartedRef\.current/u);
  assert.match(client, /if \(initialBootstrapStartedRef\.current\) return/u);
  assert.match(client, /aria-busy="true"/u);
  assert.match(actions, /'use server'/u);
  assert.match(actions, /public-share-server/u);
  assert.doesNotMatch(client, /shareToken|cookieHeader|Set-Cookie|AppShell|AuthenticatedRoute/u);
  assert.doesNotMatch(client, /<BoardRenderer|history|presence|capabilities|renderHitl/u);
});

test('public route composes the shared renderer and finalized read-only controls', () => {
  const client = source('app/s/[shareToken]/shared-board-client.tsx');
  const styles = source('app/s/[shareToken]/shared-board.module.css');
  assert.match(client, /PublicBoardRenderer/u);
  assert.match(client, /PublicArtifactPackageStoreV1/u);
  assert.match(client, /PublicShareArtifactHost/u);
  assert.match(client, /publicShareArtifactRouteKeyV1\(ready\)/u);
  assert.match(client, /current\.store\.renew\(ready\)/u);
  assert.match(
    client,
    /moveIdentity=\{`\$\{artifactRouteEpoch \?\? 'unavailable'\}:\$\{resolved\.pageId\}`\}/u,
  );
  const host = source('app/s/[shareToken]/public-share-artifact-host.tsx');
  assert.match(host, /const artifactId = artifact\.artifactId/u);
  assert.match(host, /const versionId = artifact\.versionId/u);
  assert.match(host, /\[artifactId, versionId\]/u);
  assert.match(host, /store\.open\(stableArtifact\)/u);
  assert.match(client, /renderArtifact=\{renderArtifact\}/u);
  assert.match(client, /PageNavigationControls/u);
  assert.match(client, /PresentationModeControls/u);
  assert.match(client, /<Brand linked href="https:\/\/sceneboard\.dev" label="SceneBoard" \/>/u);
  assert.match(client, /className="board-topbar board-topbar-presentation"/u);
  assert.match(client, /className="board-topbar-title"/u);
  assert.match(client, /className="board-topbar-page-navigation"/u);
  assert.doesNotMatch(client, /<h2[^>]*(?:tabIndex|data-page-heading)/u);
  assert.match(client, /toolbar=\{null\}/u);
  assert.match(client, /overlay=\{null\}/u);
  assert.doesNotMatch(client, /<PresentationControlOverlay/u);
  assert.match(client, /annotationToolbarTarget=\{annotationToolbarRef\.current\}/u);
  assert.match(client, /annotationPageKey=\{annotationPageKey\}/u);
  assert.match(client, /presentationAnnotationPageKeyV1/u);
  assert.match(client, /onPresentationPageChange=\{\(event\) =>/u);
  assert.doesNotMatch(client, /window\.addEventListener\('focus'/u);
  assert.match(client, /className=\{styles\.annotationToolbarSlot\}/u);
  assert.match(client, /presentationActive=\{presentationActive\}/u);
  assert.match(client, /page\s*\.requestFullscreen\(\)/u);
  assert.match(client, /document\.exitFullscreen/u);
  assert.match(client, /surface: 'public-share'/u);
  assert.match(styles, /height:\s*100dvh/u);
  assert.match(styles, /overflow:\s*hidden/u);
  assert.doesNotMatch(styles, /\.reader\s+:global\(\.scene-chart\)/u);
  assert.match(styles, /\.page\s+:global\(\.board-topbar-leading\)\s*\{[^}]*gap:\s*20px/su);
  assert.match(styles, /@media \(max-width: 320px\)/u);
});

test('public artifact host reuses the isolated read-only runtime without owner authority', () => {
  const host = source('app/s/[shareToken]/public-share-artifact-host.tsx');
  const loader = source('lib/api/public-share-artifact.ts');
  const bridge = source('../packages/board-ui/src/artifact/use-artifact-bridge.ts');
  const runtimePolicy = source('../packages/artifact-runtime/src/policy/csp.ts');
  assert.match(host, /showStopControl=\{false\}/u);
  assert.match(host, /handle\.preferredViewMode\(\)/u);
  assert.match(host, /viewMode=\{viewMode\}/u);
  assert.match(host, /presentationActive=\{presentationActive\}/u);
  assert.match(host, /onPresentationPageChange === undefined/u);
  assert.match(loader, /credentials: 'include'/u);
  assert.match(loader, /cache: 'no-store'/u);
  assert.match(loader, /redirect: 'error'/u);
  assert.match(loader, /PUBLIC_ARTIFACT_ACTIVE_HANDSHAKES_MAX_V1 = 2/u);
  assert.doesNotMatch(host, /BoardApiClient|authSessionClient|capabilit/u);
  assert.match(bridge, /message\.type === 'artifact\.capability\.request'/u);
  assert.match(bridge, /type: 'host\.presentation', active/u);
  assert.match(runtimePolicy, /connect-src 'none'/u);
});

test('capability loss and hard expiry share one clear-before-focus invalidation path', () => {
  const client = source('app/s/[shareToken]/shared-board-client.tsx');
  const clearIndex = client.indexOf("setAccepted({ state: { state: 'unavailable' }");
  const focusIndex = client.indexOf("focusState('[data-shared-unavailable-heading]')");
  assert.notEqual(clearIndex, -1);
  assert.notEqual(focusIndex, -1);
  assert.ok(clearIndex < focusIndex);
  assert.match(client, /requestAbortRef\.current\?\.abort\(\)/u);
  assert.match(client, /document\.exitFullscreen/u);
  assert.match(client, /document\.visibilityState === 'visible'/u);
});
