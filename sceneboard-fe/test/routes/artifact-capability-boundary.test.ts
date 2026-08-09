import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('only the authenticated live board forwards server-granted artifact capabilities', () => {
  const authenticated = source('../../app/boards/[boardId]/board-client.tsx');
  const publicShare = source('../../app/s/[shareToken]/public-share-artifact-host.tsx');
  const exported = source('../../../packages/board-ui/src/export/ExportArtifactHost.tsx');

  assert.match(
    authenticated,
    /allowedArtifactRequestCapabilities=\{session\.artifactRequestCapabilities\}/u,
  );
  assert.match(
    authenticated,
    /artifactCapabilityEpoch=\{session\.sessionAccess\.capabilityEpoch\}/u,
  );
  assert.doesNotMatch(publicShare, /allowedArtifactRequestCapabilities/u);
  assert.doesNotMatch(exported, /allowedArtifactRequestCapabilities/u);
});
