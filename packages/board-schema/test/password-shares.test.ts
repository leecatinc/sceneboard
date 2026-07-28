import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ShareErrorEnvelopeParserV1,
  ShareFingerprintInputParserV1,
  SharePasswordAdmissionRequestParserV1,
  SharePasswordReplayResultParserV1,
  SharePasswordSuccessParserV1,
} from '../src/index.js';

const share = {
  shareId: 'share_AbCdEfGhIjKlMnOpQrStUv',
  status: 'active',
  accessPolicy: 'P',
  pinnedRevisionId: '018f4f24-6f80-4cb5-9d2e-91378628ae79',
  publicationGeneration: 3,
  accessGeneration: 7,
  version: 9,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:01:00.000Z',
};

test('keeps one-time password results disjoint from non-secret replay', () => {
  const initial = {
    status: 'enabled',
    share,
    password: '23456789ABCDEFGHJKLMNPQR',
  };
  assert.equal(SharePasswordSuccessParserV1.parse(initial).ok, true);
  assert.equal(
    SharePasswordReplayResultParserV1.parse({
      status: 'already-enabled',
      shareId: share.shareId,
      copySecretAvailable: false,
      regenerateRequired: true,
    }).ok,
    true,
  );
  assert.equal(SharePasswordReplayResultParserV1.parse(initial).ok, false);
  assert.equal(
    SharePasswordSuccessParserV1.parse({ ...initial, password: `${initial.password}Z` }).ok,
    false,
  );
});

test('pins strict admission, password fingerprints, and error detail presence', () => {
  assert.equal(SharePasswordAdmissionRequestParserV1.parse({ password: 'wrong' }).ok, true);
  assert.equal(
    SharePasswordAdmissionRequestParserV1.parse({ password: 'wrong', csrfToken: 'forbidden' }).ok,
    false,
  );
  assert.equal(
    ShareFingerprintInputParserV1.parse({
      operation: 'password.regenerate',
      shareId: share.shareId,
      expectedVersion: 9,
      pinnedRevisionId: null,
    }).ok,
    true,
  );
  assert.equal(
    ShareErrorEnvelopeParserV1.parse({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Invalid request.',
        requestId: 'request_AbCdEfGhIjKlMnOpQrStUv',
        details: { reason: 'csrf' },
      },
    }).ok,
    true,
  );
  assert.equal(
    ShareErrorEnvelopeParserV1.parse({
      error: {
        code: 'BOARD_NOT_FOUND',
        message: 'Board not found.',
        requestId: 'request_AbCdEfGhIjKlMnOpQrStUv',
        details: { reason: 'body' },
      },
    }).ok,
    false,
  );
});
