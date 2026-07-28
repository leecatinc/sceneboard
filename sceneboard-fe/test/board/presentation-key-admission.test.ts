import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitPageNavigationKeyV1,
  admitPresentationEscapeKeyV1,
  type PageNavigationAdmissionV1,
} from '../../lib/board/page-navigation';

const input = (key: string): PageNavigationAdmissionV1 => ({
  key,
  defaultPrevented: false,
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  target: null,
  composedPath: [],
  hitlInteractionActive: false,
  artifactCaptureActive: false,
  moveCaptureActive: false,
});

test('presentation Escape and page navigation share the exact exclusion matrix', () => {
  assert.equal(admitPresentationEscapeKeyV1(input('Escape')), true);
  assert.equal(admitPageNavigationKeyV1(input('PageDown')), 'next');
  for (const field of [
    'defaultPrevented',
    'isComposing',
    'altKey',
    'ctrlKey',
    'metaKey',
    'hitlInteractionActive',
    'artifactCaptureActive',
    'moveCaptureActive',
  ] as const) {
    assert.equal(admitPresentationEscapeKeyV1({ ...input('Escape'), [field]: true }), false);
    assert.equal(admitPageNavigationKeyV1({ ...input('PageDown'), [field]: true }), null);
  }
  const dialog = { tagName: 'DIV', role: 'dialog', isContentEditable: false };
  assert.equal(admitPresentationEscapeKeyV1({ ...input('Escape'), composedPath: [dialog] }), false);
});
