import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyAccountMediaErrorHeaders,
  applyAccountMediaHeaders,
} from '../../src/media/media-response-policy.js';
import { applyPublicMediaHeaders } from '../../src/shares/share-response-policy.js';

const media = {
  bytes: Buffer.from('bytes'),
  mime: 'image/jpeg' as const,
  sha256Hex: 'a'.repeat(64),
  byteLength: 5,
};

const headers = () => {
  const values = new Map<string, string>();
  return {
    values,
    response: {
      setHeader: (name: string, value: string) => values.set(name, value),
    },
  };
};

test('account media policy closes the exact 200, 304, 416, 405, and 503 header sets', () => {
  const success = headers();
  applyAccountMediaHeaders(success.response, 200, media);
  assert.equal(success.values.get('Content-Type'), 'image/jpeg');
  assert.equal(success.values.get('Content-Disposition'), 'inline; filename="media.jpg"');
  assert.equal(success.values.get('ETag'), `"${media.sha256Hex}"`);
  assert.equal(success.values.get('Cache-Control'), 'private,max-age=0,must-revalidate');
  assert.equal(success.values.get('Vary'), 'Cookie');
  assert.equal(success.values.has('Content-Range'), false);

  const notModified = headers();
  applyAccountMediaHeaders(notModified.response, 304, media);
  assert.equal(notModified.values.get('ETag'), `"${media.sha256Hex}"`);
  assert.equal(notModified.values.has('Content-Type'), false);
  assert.equal(notModified.values.has('Content-Disposition'), false);

  const range = headers();
  applyAccountMediaHeaders(range.response, 416, media);
  assert.equal(range.values.get('Content-Range'), 'bytes */5');
  assert.equal(range.values.has('ETag'), false);

  const method = headers();
  applyAccountMediaErrorHeaders(method.response, 405);
  assert.equal(method.values.get('Allow'), 'GET');
  assert.equal(method.values.get('Cache-Control'), 'private,no-store');

  const unavailable = headers();
  applyAccountMediaErrorHeaders(unavailable.response, 503);
  assert.equal(unavailable.values.get('Retry-After'), '1');
});

test('public media policy is private no-store and exposes no conditional 304 branch', () => {
  const success = headers();
  applyPublicMediaHeaders(success.response, 200, {
    mime: 'image/webp',
    sha256Hex: 'b'.repeat(64),
  });
  assert.equal(success.values.get('Content-Type'), 'image/webp');
  assert.equal(success.values.get('ETag'), `"${'b'.repeat(64)}"`);
  assert.equal(success.values.get('Cache-Control'), 'private,no-store');
  assert.equal(success.values.get('Vary'), 'Cookie');
  const range = headers();
  applyPublicMediaHeaders(range.response, 416, { contentRangeLength: 99 });
  assert.equal(range.values.get('Content-Range'), 'bytes */99');
  assert.equal(range.values.get('Content-Security-Policy')?.includes("default-src 'none'"), true);
});
