import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSceneBoardContentSecurityPolicyV1 } from '../../next.config';

test('Next CSP admits exactly the configured API connection and runtime frame origins', () => {
  const policy = buildSceneBoardContentSecurityPolicyV1({
    apiOrigin: 'http://127.0.0.1:3411',
    runtimeOrigin: 'http://127.0.0.2:3412',
    mediaOrigin: 'https://media.sceneboard.dev',
  });
  assert.match(policy, /connect-src 'self' http:\/\/127\.0\.0\.1:3411/u);
  assert.match(policy, /frame-src http:\/\/127\.0\.0\.2:3412/u);
  assert.match(policy, /media-src 'self' https:\/\/media\.sceneboard\.dev/u);
  assert.doesNotMatch(policy, /frame-src[^;]*\*|frame-src[^;]*blob:|connect-src[^;]*\*/u);
  assert.doesNotMatch(policy, /media-src[^;]*\*/u);
});
