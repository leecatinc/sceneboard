import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardEventEnvelopeParserV1,
  BoardOperationResultParserV1,
  HitlInteractionParserV1,
  MutationRequestParserV1,
  MutationResultParserV1,
  PROTOCOL_SEMVER,
  PROTOCOL_VERSION,
  SceneParserV1,
  buildBoardOperationFingerprintV1,
  buildMutationFingerprintV1,
  canonicalizeJsonV1,
  normalizeActorContextV1,
  type BoardLifecycleIdempotencyEnvelopeV1,
  type MutationEnvelopeV1,
} from '../src/index.js';
import { FIXTURE_CATALOG } from './fixture-catalog.js';
import { loadFixture } from './helpers/load-fixture.js';

type JsonRecord = Record<string, unknown>;
type ScenarioDocument = JsonRecord & {
  scenario: string;
  expectedRelation: string;
};

const asRecord = (value: unknown): JsonRecord => {
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true);
  return value as JsonRecord;
};

const mergePatch = (value: unknown, patch: unknown): unknown => {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
    return structuredClone(patch);
  const output =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (structuredClone(value) as JsonRecord)
      : {};
  for (const [key, childPatch] of Object.entries(patch)) {
    output[key] = mergePatch(output[key], childPatch);
  }
  return output;
};

const canonicalText = (value: unknown): string => {
  const result = canonicalizeJsonV1(value);
  assert.equal(result.ok, true);
  if (!result.ok) return '';
  return new TextDecoder().decode(result.data.canonicalBytes);
};

const mutationFingerprintText = (value: unknown): string => {
  const result = buildMutationFingerprintV1(value as MutationEnvelopeV1);
  assert.equal(result.ok, true);
  if (!result.ok) return '';
  return new TextDecoder().decode(result.data.canonicalBytes);
};

const lifecycleFingerprintText = (value: unknown): string => {
  const result = buildBoardOperationFingerprintV1(value as BoardLifecycleIdempotencyEnvelopeV1);
  assert.equal(result.ok, true);
  if (!result.ok) return '';
  return new TextDecoder().decode(result.data.canonicalBytes);
};

const classifyMutationReuse = (
  original: MutationEnvelopeV1,
  attempted: MutationEnvelopeV1,
): string | null => {
  if (original.actor.grantId !== attempted.actor.grantId) return 'grant_changed';
  if (canonicalText(original.actor.scopes) !== canonicalText(attempted.actor.scopes))
    return 'scopes_changed';
  if (original.expectedRevisionId !== attempted.expectedRevisionId)
    return 'expected_revision_changed';
  if (canonicalText(original.command) !== canonicalText(attempted.command))
    return 'payload_changed';
  return null;
};

const classifyLifecycleReuse = (
  original: BoardLifecycleIdempotencyEnvelopeV1,
  attempted: BoardLifecycleIdempotencyEnvelopeV1,
): string | null => {
  if (original.actor.grantId !== attempted.actor.grantId) return 'grant_changed';
  if (canonicalText(original.actor.scopes) !== canonicalText(attempted.actor.scopes))
    return 'scopes_changed';
  const originalRequest = original.request as unknown as JsonRecord;
  const attemptedRequest = attempted.request as unknown as JsonRecord;
  if (
    originalRequest.type === 'board.create' &&
    attemptedRequest.type === 'board.create' &&
    originalRequest.title !== attemptedRequest.title
  )
    return 'title_changed';
  return null;
};

const classifyHitlRequestOutcome = (input: JsonRecord): string => {
  if (input.sameKey === true)
    return input.sameFingerprint === true ? 'stored_replay' : 'IDEMPOTENCY_KEY_REUSED';
  return input.existingId === true ? 'HITL_REQUEST_ID_CONFLICT' : 'success';
};

const classifyHitlRespondOutcome = (input: JsonRecord): string => {
  if (input.sameKey === true)
    return input.sameFingerprint === true ? 'stored_replay' : 'IDEMPOTENCY_KEY_REUSED';
  const state = input.state;
  if (state === 'missing') return 'HITL_REQUEST_NOT_FOUND';
  if (state === 'expired') return 'HITL_REQUEST_EXPIRED';
  if (state === 'answered' || state === 'superseded' || state === 'cancelled')
    return 'HITL_RESPONSE_CONFLICT';
  return input.definitionCompatible === false ? 'INVALID_PAYLOAD' : 'success';
};

export const evaluateScenario = async (fixture: ScenarioDocument): Promise<void> => {
  const expected = asRecord(fixture.expected);

  switch (fixture.scenario) {
    case 'scene-replace-request-id-replay':
    case 'scene-clear-idempotent-replay':
    case 'idempotency-changed-grant-conflict':
    case 'idempotency-changed-scopes-conflict':
    case 'idempotency-changed-expected-revision-conflict':
    case 'idempotency-changed-payload-conflict': {
      const original = (await loadFixture(String(fixture.originalFixture))) as MutationEnvelopeV1;
      const attempted = mergePatch(original, fixture.attemptedPatch) as MutationEnvelopeV1;
      const equal = mutationFingerprintText(original) === mutationFingerprintText(attempted);
      assert.equal(equal, expected.fingerprint === 'equal');
      assert.equal(classifyMutationReuse(original, attempted), expected.reason ?? null);
      if (expected.attemptedOperationType !== undefined)
        assert.equal(attempted.command.type, expected.attemptedOperationType);
      break;
    }
    case 'idempotency-scopes-reordered-replay': {
      const candidates = fixture.actorCandidates as unknown[];
      assert.equal(candidates.length, 2);
      const normalized = candidates.map((candidate) => normalizeActorContextV1(candidate));
      for (const result of normalized) assert.equal(result.ok, true);
      if (!normalized[0]?.ok || !normalized[1]?.ok) break;
      assert.deepEqual(normalized[0].data.value.scopes, expected.normalizedScopes);
      assert.deepEqual(normalized[0].data.canonicalBytes, normalized[1].data.canonicalBytes);
      const base = (await loadFixture(String(fixture.envelopeFixture))) as MutationEnvelopeV1;
      const first = { ...base, actor: normalized[0].data.value };
      const second = {
        ...base,
        requestId: String(expected.retryRequestId),
        actor: normalized[1].data.value,
      } as MutationEnvelopeV1;
      assert.equal(mutationFingerprintText(first), mutationFingerprintText(second));
      assert.equal(
        buildMutationFingerprintV1({ ...base, actor: candidates[0] } as MutationEnvelopeV1).ok,
        false,
      );
      break;
    }
    case 'compatibility-v1-exact':
    case 'compatibility-v1-added-field-rejected': {
      const result = SceneParserV1.parse(await loadFixture(String(fixture.inputFixture)));
      assert.equal(result.ok, expected.accepted);
      break;
    }
    case 'compatibility-major-mismatch-bidirectional': {
      const cases = fixture.cases as JsonRecord[];
      for (const item of cases) assert.equal(item.readerMajor === item.writerMajor, item.accepted);
      const v2 = SceneParserV1.parse({ protocolVersion: 2, type: 'scene', root: null });
      assert.equal(v2.ok, false);
      if (!v2.ok) assert.equal(v2.error.code, 'PROTOCOL_VERSION_MISMATCH');
      break;
    }
    case 'board-create-initial-empty-head': {
      const result = BoardOperationResultParserV1.parse(
        await loadFixture(String(fixture.resultFixture)),
      );
      assert.equal(result.ok, true);
      if (!result.ok || result.data.value.result.type !== 'board.create') break;
      const created = result.data.value.result;
      assert.equal(created.snapshot.revision.revisionNumber, expected.revisionNumber);
      assert.equal(created.snapshot.scene.root, null);
      assert.equal(created.board.headRevision.revisionId, created.snapshot.revision.revisionId);
      break;
    }
    case 'board-get-initial-snapshot': {
      const created = BoardOperationResultParserV1.parse(
        await loadFixture(String(fixture.createResultFixture)),
      );
      const fetched = BoardOperationResultParserV1.parse(
        await loadFixture(String(fixture.getResultFixture)),
      );
      assert.equal(created.ok && fetched.ok, true);
      if (
        !created.ok ||
        !fetched.ok ||
        created.data.value.result.type !== 'board.create' ||
        fetched.data.value.result.type !== 'board.get'
      )
        break;
      assert.equal(
        created.data.value.result.snapshot.revision.revisionId,
        fetched.data.value.result.snapshot.revision.revisionId,
      );
      assert.equal(fetched.data.value.result.snapshot.scene.root, null);
      break;
    }
    case 'first-scene-replace-from-created-head': {
      const created = BoardOperationResultParserV1.parse(
        await loadFixture(String(fixture.createResultFixture)),
      );
      const request = MutationRequestParserV1.parse(
        await loadFixture(String(fixture.requestFixture)),
      );
      const result = MutationResultParserV1.parse(await loadFixture(String(fixture.resultFixture)));
      assert.equal(created.ok && request.ok && result.ok, true);
      if (
        !created.ok ||
        !request.ok ||
        !result.ok ||
        created.data.value.result.type !== 'board.create' ||
        result.data.value.result.type !== 'scene.replace'
      )
        break;
      assert.equal(
        request.data.value.expectedRevisionId,
        created.data.value.result.snapshot.revision.revisionId,
      );
      assert.equal(result.data.value.result.revision.revisionNumber, expected.revisionNumber);
      break;
    }
    case 'scene-clear-after-create': {
      const created = BoardOperationResultParserV1.parse(
        await loadFixture(String(fixture.createResultFixture)),
      );
      const result = MutationResultParserV1.parse(await loadFixture(String(fixture.resultFixture)));
      assert.equal(created.ok && result.ok, true);
      if (
        !created.ok ||
        !result.ok ||
        created.data.value.result.type !== 'board.create' ||
        result.data.value.result.type !== 'scene.clear'
      )
        break;
      assert.equal(result.data.value.result.revision.revisionNumber, expected.revisionNumber);
      assert.equal(
        result.data.value.result.revision.revisionNumber >
          created.data.value.result.snapshot.revision.revisionNumber,
        true,
      );
      break;
    }
    case 'hitl-placement-reconnect-correlation': {
      const snapshot = asRecord(await loadFixture(String(fixture.snapshotFixture)));
      const event = BoardEventEnvelopeParserV1.parse(
        await loadFixture(String(fixture.eventFixture)),
      );
      assert.equal(event.ok, true);
      if (!event.ok || event.data.value.data.type !== 'hitl.updated') break;
      snapshot.hitl = [event.data.value.data.hitl];
      const parsed = (await import('../src/index.js')).BoardSnapshotParserV1.parse(snapshot);
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.equal(parsed.data.value.hitl[0]?.hitlRequestId, expected.hitlRequestId);
      break;
    }
    case 'canonical-unicode-key-order': {
      assert.equal(canonicalText(fixture.input), expected.canonicalJson);
      break;
    }
    case 'board-create-idempotency-replay':
    case 'board-archive-idempotency-replay': {
      const original = (await loadFixture(
        String(fixture.originalFixture),
      )) as BoardLifecycleIdempotencyEnvelopeV1;
      const attempted = mergePatch(
        original,
        fixture.attemptedPatch,
      ) as BoardLifecycleIdempotencyEnvelopeV1;
      assert.equal(lifecycleFingerprintText(original), lifecycleFingerprintText(attempted));
      assert.equal(classifyLifecycleReuse(original, attempted), null);
      break;
    }
    case 'board-create-idempotency-reuse-conflicts':
    case 'board-archive-idempotency-reuse-conflicts': {
      const original = (await loadFixture(
        String(fixture.originalFixture),
      )) as BoardLifecycleIdempotencyEnvelopeV1;
      for (const item of fixture.cases as JsonRecord[]) {
        const attempted = mergePatch(original, item.patch) as BoardLifecycleIdempotencyEnvelopeV1;
        assert.notEqual(lifecycleFingerprintText(original), lifecycleFingerprintText(attempted));
        assert.equal(classifyLifecycleReuse(original, attempted), item.reason);
      }
      break;
    }
    case 'snapshot-event-reconnect-watermark': {
      const result = BoardEventEnvelopeParserV1.parse(
        await loadFixture(String(fixture.eventFixture)),
      );
      assert.equal(result.ok, true);
      if (!result.ok) break;
      const event = result.data.value;
      const data = event.data;
      if (data.type !== 'board.snapshot') assert.fail('scenario must contain a snapshot event');
      assert.equal(event.sequence, data.snapshot.lastEventSequence);
      for (const sequence of fixture.duplicateSequences as number[])
        assert.equal(sequence <= event.sequence, true);
      assert.equal(expected.firstAcceptedSequence, event.sequence + 1);
      break;
    }
    case 'hitl-terminal-chronology-boundaries': {
      for (const path of fixture.validFixtures as string[])
        assert.equal(HitlInteractionParserV1.parse(await loadFixture(path)).ok, true, path);
      for (const path of fixture.invalidFixtures as string[])
        assert.equal(HitlInteractionParserV1.parse(await loadFixture(path)).ok, false, path);
      for (const item of fixture.readCases as JsonRecord[]) {
        const changed =
          Date.parse(String(item.returnedStateUpdatedAt)) >
          Date.parse(String(item.afterStateUpdatedAt));
        assert.equal(changed, item.changed);
      }
      break;
    }
    case 'hitl-request-result-outcomes': {
      const request = MutationRequestParserV1.parse(
        await loadFixture(String(fixture.requestFixture)),
      );
      const result = MutationResultParserV1.parse(await loadFixture(String(fixture.resultFixture)));
      assert.equal(request.ok && result.ok, true);
      if (
        !request.ok ||
        !result.ok ||
        request.data.value.command.type !== 'hitl.request' ||
        result.data.value.result.type !== 'hitl.request'
      )
        break;
      assert.equal(
        request.data.value.command.hitlRequestId,
        result.data.value.result.hitl.hitlRequestId,
      );
      assert.equal(
        canonicalText(request.data.value.command.request),
        canonicalText(result.data.value.result.hitl.definition),
      );
      assert.equal(result.data.value.result.hitl.state, 'open');
      for (const item of fixture.outcomeCases as JsonRecord[])
        assert.equal(classifyHitlRequestOutcome(item), item.outcome);
      break;
    }
    case 'hitl-respond-result-outcomes': {
      const request = MutationRequestParserV1.parse(
        await loadFixture(String(fixture.requestFixture)),
      );
      const result = MutationResultParserV1.parse(await loadFixture(String(fixture.resultFixture)));
      assert.equal(request.ok && result.ok, true);
      if (
        !request.ok ||
        !result.ok ||
        request.data.value.command.type !== 'hitl.respond' ||
        result.data.value.result.type !== 'hitl.respond'
      )
        break;
      assert.equal(
        request.data.value.command.hitlRequestId,
        result.data.value.result.hitl.hitlRequestId,
      );
      assert.equal(
        canonicalText(request.data.value.command.response),
        canonicalText(result.data.value.result.hitl.response),
      );
      assert.equal(result.data.value.result.hitl.state, 'answered');
      for (const item of fixture.outcomeCases as JsonRecord[])
        assert.equal(classifyHitlRespondOutcome(item), item.outcome);
      break;
    }
    default:
      assert.fail(`No evaluator registered for ${fixture.scenario}`);
  }
};

if (process.env.SCENEBOARD_SCENARIO_EVALUATOR_LIBRARY !== '1') {
  test('pins the frozen v1 protocol identity', () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.equal(PROTOCOL_SEMVER, '1.0.0');
  });

  test('accepts exact v1 and rejects added fields and both major mismatches', async () => {
    assert.equal(SceneParserV1.parse(await loadFixture('valid/scene-empty.v1.json')).ok, true);
    assert.equal(
      SceneParserV1.parse(await loadFixture('invalid/protocol-v1-added-field.v1.json')).ok,
      false,
    );
    const future = SceneParserV1.parse({ protocolVersion: 2, type: 'scene', root: null });
    assert.equal(future.ok, false);
    if (!future.ok) assert.equal(future.error.code, 'PROTOCOL_VERSION_MISMATCH');
  });

  for (const entry of FIXTURE_CATALOG) {
    if (entry.kind !== 'scenario') continue;
    test(`executes deterministic scenario: ${entry.evaluator}`, async () => {
      const fixture = (await loadFixture(entry.path)) as ScenarioDocument;
      assert.equal(fixture.scenario, entry.evaluator);
      assert.equal(fixture.expectedRelation, entry.expectedRelation);
      await evaluateScenario(fixture);
    });
  }
}
