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
  assert.equal((boardClient.match(/<ShareManagementSheet/gu) ?? []).length, 1);
  assert.equal((boardClient.match(/<MemberManagementSheet/gu) ?? []).length, 1);
  assert.match(boardClient, /ownerAdmin,/u);
  assert.equal((chrome.match(/ownerAdmin=\{slots\.ownerAdmin\}/gu) ?? []).length, 1);
  assert.match(chrome, /<MobileBoardDrawer slots=\{slots\}/u);
});
