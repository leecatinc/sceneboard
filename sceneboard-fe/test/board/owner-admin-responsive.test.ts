import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('BoardClient constructs one ownerAdmin node and routes it through the rail (desktop) and drawer (mobile)', () => {
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
  const rail = readFileSync(
    new URL('../../components/board/BoardUtilityRail.tsx', import.meta.url),
    'utf8',
  );
  assert.equal((boardClient.match(/<OwnerAdminControls\s/gu) ?? []).length, 1);
  assert.equal((ownerControls.match(/<ShareManagementSheet/gu) ?? []).length, 1);
  assert.equal((ownerControls.match(/<MemberManagementSheet/gu) ?? []).length, 1);
  assert.match(boardClient, /ownerAdmin,/u);
  assert.match(boardClient, /closeAndClearOwnerAdmin/u);
  // Desktop: owner-management controls route to the utility rail's access panel.
  assert.match(boardClient, /<BoardUtilityRail[\s\S]*?ownerAdmin=\{ownerAdmin\}/u);
  assert.match(rail, /'access'/u);
  assert.match(rail, /ownerAdmin\?: ReactNode/u);
  // The top bar no longer renders owner management directly (destructive actions are not permanently exposed at the top level).
  assert.doesNotMatch(chrome, /ownerAdmin=\{slots\.ownerAdmin\}/u);
  // The mobile drawer owns owner management through its slot-based contract.
  assert.match(chrome, /<MobileBoardDrawer slots=\{slots\}/u);
});
