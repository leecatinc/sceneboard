import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPublicShareLocatorV1, buildPublicShareUrlV1 } from '../../lib/board/share-link';

test('active shares are presented as persistent complete public board URLs', () => {
  const shareId = 'share_abcdefghijklmnopqrstuv';
  assert.equal(buildPublicShareLocatorV1(shareId, 7), 'share_abcdefghijklmnopqrstuv_g7');
  assert.equal(
    buildPublicShareUrlV1('https://sceneboard.leecat.co.kr', shareId, 7),
    'https://sceneboard.leecat.co.kr/s/share_abcdefghijklmnopqrstuv_g7',
  );
});

test('share URL construction rejects a non-canonical application origin', () => {
  assert.throws(
    () =>
      buildPublicShareUrlV1(
        'https://sceneboard.leecat.co.kr/path',
        'share_abcdefghijklmnopqrstuv',
        1,
      ),
    /canonical/u,
  );
});
