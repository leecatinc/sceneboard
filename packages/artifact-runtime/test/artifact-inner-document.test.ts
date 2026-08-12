import assert from 'node:assert/strict';
import test from 'node:test';

import { composeArtifactInnerDocumentV1 } from '../src/runner/inner-document.js';
import { buildInnerPolicyV1 } from '../src/policy/index.js';

test('trusted bootstrap precedes every authored HTML byte', () => {
  const document = composeArtifactInnerDocumentV1({
    policy: "default-src 'none'",
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAA',
    mermaidTag: '<script id="mermaid"></script>',
    threeTag: '<script id="three"></script>',
    resourcesTag: '<template id="resources"></template>',
    bootstrapTag: '<script id="trusted-bootstrap"></script>',
    html: '<script id="authored"></script><main>artifact</main>',
  });
  assert.ok(document.indexOf('resources') < document.indexOf('trusted-bootstrap'));
  assert.ok(document.indexOf('trusted-bootstrap') < document.indexOf('id="mermaid"'));
  assert.ok(document.indexOf('trusted-bootstrap') < document.indexOf('id="three"'));
  assert.ok(document.indexOf('trusted-bootstrap') < document.indexOf('<body>'));
  assert.ok(document.indexOf('trusted-bootstrap') < document.indexOf('id="authored"'));
  assert.match(document, /<style nonce="AAAAAAAAAAAAAAAAAAAAAAAA">/u);
});

test('inner policy admits only nonce-authorized bootstrap and post-init blob scripts', () => {
  const policy = buildInnerPolicyV1('AAAAAAAAAAAAAAAAAAAAAA');
  assert.match(policy, /script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA' blob:/u);
  assert.doesNotMatch(policy, /script-src[^;]*data:/u);
  assert.match(
    buildInnerPolicyV1('AAAAAAAAAAAAAAAAAAAAAAAA'),
    /script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAAAA' blob:/u,
  );
  assert.throws(() => buildInnerPolicyV1('too-short'), /nonce is invalid/u);
});
