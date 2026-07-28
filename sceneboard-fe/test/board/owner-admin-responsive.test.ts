import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('BoardClient constructs one ownerAdmin node and responsive chrome owns the sole mount', () => {
  const boardClient = readFileSync(
    new URL('../../app/boards/[boardId]/board-client.tsx', import.meta.url),
    'utf8',
  );
  const chrome = readFileSync(
    new URL('../../components/board/ResponsiveBoardChrome.tsx', import.meta.url),
    'utf8',
  );
  const ownerControls = readFileSync(
    new URL('../../components/board/OwnerAdminControls.tsx', import.meta.url),
    'utf8',
  );
  assert.equal((boardClient.match(/<OwnerAdminControls\s/gu) ?? []).length, 1);
  assert.equal((ownerControls.match(/<ShareManagementSheet/gu) ?? []).length, 1);
  assert.equal((ownerControls.match(/<MemberManagementSheet/gu) ?? []).length, 1);
  assert.match(boardClient, /ownerAdmin,/u);
  assert.match(boardClient, /closeAndClearOwnerAdmin/u);
  assert.equal((chrome.match(/ownerAdmin=\{slots\.ownerAdmin\}/gu) ?? []).length, 1);
  assert.match(chrome, /<MobileBoardDrawer slots=\{slots\}/u);
});
