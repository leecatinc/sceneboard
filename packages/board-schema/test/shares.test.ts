import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ShareErrorEnvelopeParserV1,
  ShareFingerprintInputParserV1,
  ShareIdempotencyKeyParserV1,
  ShareLinkTokenParserV1,
  ShareListResultParserV1,
  SharePublishRequestParserV1,
  SharePublishSuccessParserV1,
  ShareSecretReplayResultParserV1,
  ShareUpdateRequestParserV1,
  ShareUpdateSuccessParserV1,
} from '../src/index.js';

const view = {
  shareId: 'share_1',
  status: 'active',
  accessPolicy: 'L',
  pinnedRevisionId: 'revision_1',
  publicationGeneration: 1,
  accessGeneration: 1,
  version: 1,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

test('admits only the exact share management view and bounded singleton list', () => {
  assert.equal(ShareListResultParserV1.parse({ shares: [view] }).ok, true);
  assert.equal(ShareListResultParserV1.parse({ shares: [view, view] }).ok, false);
  assert.equal(ShareListResultParserV1.parse({ shares: [{ ...view, expiresAt: null }] }).ok, false);
});

test('rejects deferred access, expiry, audience, domain, and listing request keys', () => {
  assert.equal(SharePublishRequestParserV1.parse({ pinnedRevisionId: 'revision_1' }).ok, true);
  for (const key of ['accessPolicy', 'expiresAt', 'audience', 'domain', 'listing']) {
    assert.equal(
      SharePublishRequestParserV1.parse({
        pinnedRevisionId: 'revision_1',
        [key]: null,
      }).ok,
      false,
      key,
    );
  }
  assert.equal(
    ShareUpdateRequestParserV1.parse({
      pinnedRevisionId: 'revision_2',
      expectedVersion: 1,
    }).ok,
    true,
  );
});

test('keeps initial secret responses and every replay result structurally disjoint', () => {
  const token = 'A'.repeat(43);
  assert.equal(
    SharePublishSuccessParserV1.parse({ status: 'created', share: view, linkToken: token }).ok,
    true,
  );
  assert.equal(
    ShareSecretReplayResultParserV1.parse({
      status: 'already-created',
      shareId: 'share_1',
      copySecretAvailable: false,
      rotateRequired: true,
    }).ok,
    true,
  );
  assert.equal(ShareUpdateSuccessParserV1.parse({ status: 'unchanged', share: view }).ok, true);
  assert.equal(ShareLinkTokenParserV1.parse(token).ok, true);
  assert.equal(ShareLinkTokenParserV1.parse(`${token}A`).ok, false);
});

test('pins printable idempotency keys and the closed share error envelope', () => {
  assert.equal(ShareIdempotencyKeyParserV1.parse('share-operation:0001').ok, true);
  assert.equal(ShareIdempotencyKeyParserV1.parse('short').ok, false);
  assert.equal(
    ShareErrorEnvelopeParserV1.parse({
      error: {
        code: 'SHARE_STATE_CONFLICT',
        message: 'Share state does not allow this operation',
        requestId: 'request_1',
      },
    }).ok,
    true,
  );
  assert.equal(
    ShareErrorEnvelopeParserV1.parse({
      error: {
        code: 'FORBIDDEN',
        message: 'Forbidden',
        requestId: 'request_1',
      },
    }).ok,
    false,
  );
});

test('closes the canonical idempotency fingerprint shape and operation catalog', () => {
  assert.equal(
    ShareFingerprintInputParserV1.parse({
      operation: 'update',
      shareId: 'share_1',
      expectedVersion: 2,
      pinnedRevisionId: 'revision_2',
    }).ok,
    true,
  );
  assert.equal(
    ShareFingerprintInputParserV1.parse({
      operation: 'archive',
      shareId: 'share_1',
      expectedVersion: 2,
      pinnedRevisionId: null,
    }).ok,
    false,
  );
  assert.equal(
    ShareFingerprintInputParserV1.parse({
      operation: 'rotate',
      shareId: 'share_1',
      expectedVersion: 2,
      pinnedRevisionId: null,
      accessPolicy: 'P',
    }).ok,
    false,
  );
});
