import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) =>
  readFile(new URL(`../../sceneboard-be/src/pairing/${path}`, import.meta.url), 'utf8');

test('pairing persistence is split by request, decision, client, and owner responsibility', async () => {
  const [facade, request, decision, client, owner, context] = await Promise.all([
    source('pairing.repository.ts'),
    source('pairing-request.persistence.ts'),
    source('pairing-decision.persistence.ts'),
    source('pairing-client.persistence.ts'),
    source('pairing-owner.persistence.ts'),
    source('pairing-persistence.context.ts'),
  ]);

  assert.doesNotMatch(facade, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/u);
  assert.ok(facade.split('\n').length <= 220);
  assert.match(request, /async create\(/u);
  assert.match(request, /async claim\(/u);
  assert.match(decision, /async decide\(/u);
  assert.match(client, /async clientStatus\(/u);
  assert.match(client, /async redeem\(/u);
  assert.match(owner, /async ownerStatus\(/u);
  assert.match(owner, /async listActive\(/u);
  assert.match(owner, /async cancel\(/u);
  assert.doesNotMatch(
    context,
    /async (?:create|claim|decide|clientStatus|redeem|ownerStatus|listActive|cancel)\(/u,
  );
});
