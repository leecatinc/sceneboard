import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MutationEnvelopeParserV1,
  MutationRequestParserV1,
  MutationResultParserV1,
  buildMutationFingerprintV1,
  normalizeActorContextV1,
  type MutationEnvelopeV1,
} from '../src/index.js';
import { loadFixture } from './helpers/load-fixture.js';

test('rejects caller-supplied actors and non-normalized attested scopes', async () => {
  assert.equal(
    MutationRequestParserV1.parse(
      await loadFixture('invalid/mutation-request-caller-actor.v1.json'),
    ).ok,
    false,
  );
  assert.equal(
    MutationEnvelopeParserV1.parse(
      await loadFixture('invalid/mutation-envelope-unsorted-scopes.v1.json'),
    ).ok,
    false,
  );
});

test('normalizes adapter candidates without mutating them', () => {
  const candidate = {
    principalKind: 'user',
    principalId: 'user_1',
    grantId: 'grant_1',
    scopes: ['board.write', 'board.read', 'board.write'],
  };
  const original = structuredClone(candidate);
  const result = normalizeActorContextV1(candidate);
  assert.equal(result.ok, true);
  assert.deepEqual(candidate, original);
  if (result.ok) assert.deepEqual(result.data.value.scopes, ['board.read', 'board.write']);
});

test('fingerprints exclude request and idempotency keys but include authorization and payload', async () => {
  const envelope = (await loadFixture(
    'valid/mutation-envelope-scene-clear.v1.json',
  )) as MutationEnvelopeV1;
  const baseline = buildMutationFingerprintV1(envelope);
  assert.equal(baseline.ok, true);
  const retry: MutationEnvelopeV1 = {
    ...envelope,
    requestId: 'request_2' as MutationEnvelopeV1['requestId'],
    idempotencyKey: 'idempotency-key-2' as MutationEnvelopeV1['idempotencyKey'],
  };
  const replay = buildMutationFingerprintV1(retry);
  assert.equal(replay.ok, true);
  if (baseline.ok && replay.ok)
    assert.deepEqual(replay.data.canonicalBytes, baseline.data.canonicalBytes);
  const changed = buildMutationFingerprintV1({
    ...retry,
    expectedRevisionId: 'revision_2' as MutationEnvelopeV1['expectedRevisionId'],
  });
  assert.equal(changed.ok, true);
  if (baseline.ok && changed.ok)
    assert.notDeepEqual(changed.data.canonicalBytes, baseline.data.canonicalBytes);
});

test('keeps seven mutation request variants distinct', async () => {
  for (const type of [
    'scene-replace',
    'scene-clear',
    'scene-restore',
    'hitl-request',
    'hitl-respond',
    'artifact-stop',
    'artifact-publish',
  ]) {
    assert.equal(
      MutationRequestParserV1.parse(await loadFixture(`valid/mutation-request-${type}.v1.json`)).ok,
      true,
      type,
    );
  }
});

test('keeps all seven attested envelope and result variants distinct', async () => {
  for (const type of [
    'scene-replace',
    'scene-clear',
    'scene-restore',
    'hitl-request',
    'hitl-respond',
    'artifact-stop',
    'artifact-publish',
  ]) {
    assert.equal(
      MutationEnvelopeParserV1.parse(await loadFixture(`valid/mutation-envelope-${type}.v1.json`))
        .ok,
      true,
      `${type} envelope`,
    );
    assert.equal(
      MutationResultParserV1.parse(await loadFixture(`valid/mutation-result-${type}.v1.json`)).ok,
      true,
      `${type} result`,
    );
  }
});

test('requires non-null expected heads and unique event IDs', async () => {
  assert.equal(
    MutationRequestParserV1.parse(
      await loadFixture('invalid/mutation-request-missing-expected-revision.v1.json'),
    ).ok,
    false,
  );
  assert.equal(
    MutationRequestParserV1.parse(
      await loadFixture('invalid/mutation-request-null-expected-revision.v1.json'),
    ).ok,
    false,
  );
  const result = (await loadFixture('valid/mutation-result-scene-clear.v1.json')) as Record<
    string,
    unknown
  >;
  assert.equal(
    MutationResultParserV1.parse({ ...result, eventIds: ['event_1', 'event_1'] }).ok,
    false,
  );
});

test('rejects both duplicate and out-of-order claimed scopes while normalized candidates converge', async () => {
  const envelope = (await loadFixture(
    'valid/mutation-envelope-scene-clear.v1.json',
  )) as MutationEnvelopeV1;
  for (const scopes of [
    ['board.read', 'board.read'],
    ['board.write', 'board.read'],
  ]) {
    const claimed = { ...envelope, actor: { ...envelope.actor, scopes } } as MutationEnvelopeV1;
    const parsed = MutationEnvelopeParserV1.parse(claimed);
    assert.equal(parsed.ok, false);
    if (!parsed.ok)
      assert.deepEqual(parsed.error.details, {
        path: ['actor', 'scopes'],
        issue: 'scopes must be sorted and unique',
      });
    assert.equal(buildMutationFingerprintV1(claimed).ok, false);
  }
  const first = normalizeActorContextV1({
    ...envelope.actor,
    scopes: ['board.write', 'board.read', 'board.write'],
  });
  const second = normalizeActorContextV1({
    ...envelope.actor,
    scopes: ['board.read', 'board.write'],
  });
  assert.equal(first.ok && second.ok, true);
  if (first.ok && second.ok)
    assert.deepEqual(first.data.canonicalBytes, second.data.canonicalBytes);
});
