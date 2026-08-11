import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTabsSelectionV1 } from '../src/renderer/layouts/TabsLayout.js';

const tabs = [{ tabId: 'part-1' }, { tabId: 'part-2' }, { tabId: 'part-3' }] as const;

test('uncontrolled tabs keep the locally selected tab instead of resetting to the authored default', () => {
  assert.equal(resolveTabsSelectionV1(tabs, undefined, 'part-2', 'part-1'), 'part-2');
});

test('a valid controlled tab wins while invalid external state falls back to local selection', () => {
  assert.equal(resolveTabsSelectionV1(tabs, 'part-3', 'part-2', 'part-1'), 'part-3');
  assert.equal(resolveTabsSelectionV1(tabs, 'missing', 'part-2', 'part-1'), 'part-2');
});
