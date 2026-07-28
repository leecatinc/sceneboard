import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_DOCUMENT_LIMITS_V2,
  BoardErrorParser,
  BoardNodeParserV1,
  MediaIdParserV1,
} from '../src/index.js';

const mediaImage = {
  id: 'image',
  type: 'content.image',
  source: { type: 'media', mediaId: 'media_01' },
  alt: 'Accessible description',
  caption: 'Caption',
  fit: 'cover',
} as const;

test('accepts exact accessible and decorative media image branches', () => {
  assert.equal(BoardNodeParserV1.parse(mediaImage).ok, true);
  const { caption: _caption, ...decorativeImage } = mediaImage;
  assert.equal(
    BoardNodeParserV1.parse({
      ...decorativeImage,
      decorative: true,
      alt: '',
    }).ok,
    true,
  );
  assert.equal(
    BoardErrorParser.parse({
      protocolVersion: 1,
      type: 'board.error',
      code: 'INVALID_MEDIA_REFERENCE',
      message: 'Invalid media reference',
      category: 'validation',
      retryable: false,
      httpStatusHint: 400,
      details: { reason: 'unavailable', mediaId: 'media_1' },
    }).ok,
    false,
  );
});

test('rejects ambiguous, unknown, and unbounded media image shapes', () => {
  for (const input of [
    { ...mediaImage, alt: '' },
    { ...mediaImage, decorative: true },
    { ...mediaImage, decorative: true, alt: '', caption: 'not allowed' },
    { ...mediaImage, source: { ...mediaImage.source, extra: true } },
    { ...mediaImage, source: { type: 'media', mediaId: '한글' } },
    { ...mediaImage, caption: 'x'.repeat(501) },
  ]) {
    assert.equal(BoardNodeParserV1.parse(input).ok, false);
  }
});

test('pins media identifiers, limits, and unavailable reference error', () => {
  assert.equal(MediaIdParserV1.parse('legacy-image_1').ok, true);
  assert.equal(MediaIdParserV1.parse('x'.repeat(128)).ok, true);
  assert.equal(MediaIdParserV1.parse('x'.repeat(129)).ok, false);
  assert.deepEqual(
    {
      maxMediaBytes: BOARD_DOCUMENT_LIMITS_V2.maxMediaBytes,
      maxMediaPixels: BOARD_DOCUMENT_LIMITS_V2.maxMediaPixels,
      maxBoardMediaBytes: BOARD_DOCUMENT_LIMITS_V2.maxBoardMediaBytes,
      maxMediaReferences: BOARD_DOCUMENT_LIMITS_V2.maxMediaReferences,
    },
    {
      maxMediaBytes: 10_485_760,
      maxMediaPixels: 40_000_000,
      maxBoardMediaBytes: 536_870_912,
      maxMediaReferences: 5_000,
    },
  );
  assert.equal(
    BoardErrorParser.parse({
      protocolVersion: 1,
      type: 'board.error',
      code: 'INVALID_MEDIA_REFERENCE',
      message: 'Invalid media reference',
      category: 'validation',
      retryable: false,
      httpStatusHint: 400,
      details: { reason: 'unavailable' },
    }).ok,
    true,
  );
});
