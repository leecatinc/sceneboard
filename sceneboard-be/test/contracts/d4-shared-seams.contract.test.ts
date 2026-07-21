import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTHORIZED_BROWSER_PRESENCE_PORT_V1,
  PresenceModule,
  type AuthorizedBrowserPresencePortV1,
  type AuthorizedBrowserPresenceSubjectV1,
} from '../../src/presence/presence.module.js';

const compileTypes = (
  _port: AuthorizedBrowserPresencePortV1 | null,
  _subject: AuthorizedBrowserPresenceSubjectV1 | null,
): void => undefined;

test('D4 presence exports one opaque DI seam without a raw-ID lookup', () => {
  compileTypes(null, null);
  assert.equal(typeof AUTHORIZED_BROWSER_PRESENCE_PORT_V1, 'symbol');
  assert.equal(typeof PresenceModule, 'function');
  assert.equal(Object.hasOwn(PresenceModule.prototype, 'getStatus'), false);
});
