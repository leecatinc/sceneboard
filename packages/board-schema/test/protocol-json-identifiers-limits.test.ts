import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ArtifactManifestParserV1,
  ArtifactReferenceParserV1,
  ArtifactResourceParserV1,
  ArtifactRuntimeSummaryParserV1,
  BoardCapabilitiesParserV1,
  BoardDocumentParserV2,
  BoardIdParserV1,
  BoardErrorParserV1,
  BoardEventEnvelopeParserV1,
  BoardNodeParserV1,
  BoardOperationEnvelopeParserV1,
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  BoardSnapshotParserV1,
  HitlInteractionParserV1,
  HitlRequestDefinitionParserV1,
  HitlResponseParserV1,
  GlobalIdStringParserV1,
  GrantIdParserV1,
  MutationEnvelopeParserV1,
  MutationRequestParserV1,
  MutationResultParserV1,
  NodeIdParserV1,
  PrincipalIdParserV1,
  RetainedHistoryMetadataParserV1,
  SceneParserV1,
  canonicalizeJsonV1,
  type BoardContractParser,
  type BoardContractParserV1,
} from '../src/index.js';
import { FIXTURE_CATALOG, type FixtureParserName } from './fixture-catalog.js';
import { listFixturePaths, loadFixture, loadFixtureBytes } from './helpers/load-fixture.js';

const canonicalParser: BoardContractParserV1<unknown> = {
  parse: canonicalizeJsonV1,
  parseBytes: (bytes) => {
    try {
      return canonicalizeJsonV1(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
      );
    } catch {
      return canonicalizeJsonV1(undefined);
    }
  },
};

const parsers: Record<FixtureParserName, BoardContractParser<unknown>> = {
  ArtifactManifestParserV1,
  ArtifactReferenceParserV1,
  ArtifactResourceParserV1,
  ArtifactRuntimeSummaryParserV1,
  BoardCapabilitiesParserV1,
  BoardDocumentParserV2,
  BoardErrorParserV1,
  BoardEventEnvelopeParserV1,
  BoardNodeParserV1,
  BoardOperationEnvelopeParserV1,
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  BoardSnapshotParserV1,
  CanonicalJsonParserV1: canonicalParser,
  HitlInteractionParserV1,
  HitlRequestDefinitionParserV1,
  HitlResponseParserV1,
  MutationEnvelopeParserV1,
  MutationRequestParserV1,
  MutationResultParserV1,
  RetainedHistoryMetadataParserV1,
  SceneParserV1,
};

test('keeps the application scalar parser wire set exact', () => {
  const accepted = ['A', '_', '-', 'a0_-', 'x'.repeat(128)];
  const rejected = ['', 'x'.repeat(129), 'with.dot', 'with:colon', '한글', 'has space'];
  for (const parser of [
    GlobalIdStringParserV1,
    BoardIdParserV1,
    GrantIdParserV1,
    PrincipalIdParserV1,
  ]) {
    for (const value of accepted) {
      const decoded = parser.parse(value);
      assert.equal(decoded.ok, true, value);
      const encoded = parser.parseBytes(new TextEncoder().encode(JSON.stringify(value)));
      assert.equal(encoded.ok, true, `${value} bytes`);
      if (decoded.ok && encoded.ok) assert.equal(encoded.data.value, decoded.data.value);
    }
    for (const value of rejected) assert.equal(parser.parse(value).ok, false, value);
  }
});

test('keeps local node identifiers distinct from global identifiers', () => {
  for (const value of ['A', 'node_1', `n${'x'.repeat(63)}`])
    assert.equal(NodeIdParserV1.parse(value).ok, true, value);
  for (const value of ['1node', '_node', 'x'.repeat(65), 'node.with.dot'])
    assert.equal(NodeIdParserV1.parse(value).ok, false, value);
});

test('registers every exact fixture once with complete metadata', async () => {
  assert.equal(FIXTURE_CATALOG.length, 188);
  assert.equal(new Set(FIXTURE_CATALOG.map((entry) => entry.path)).size, 188);
  assert.deepEqual(
    [
      FIXTURE_CATALOG.filter((entry) => entry.kind === 'valid').length,
      FIXTURE_CATALOG.filter((entry) => entry.kind === 'scenario').length,
      FIXTURE_CATALOG.filter((entry) => entry.kind === 'invalid').length,
    ],
    [107, 24, 57],
  );
  assert.deepEqual(await listFixturePaths(), FIXTURE_CATALOG.map((entry) => entry.path).sort());
  for (const entry of FIXTURE_CATALOG) await loadFixture(entry.path);
});

test('parses every valid fixture through its declared public parser', async () => {
  for (const entry of FIXTURE_CATALOG) {
    if (entry.kind !== 'valid') continue;
    const parser = parsers[entry.schema];
    const decoded = parser.parse(await loadFixture(entry.path));
    assert.equal(decoded.ok, true, entry.path);
    const encoded = parser.parseBytes(await loadFixtureBytes(entry.path));
    assert.equal(encoded.ok, true, `${entry.path} bytes`);
    if (decoded.ok && encoded.ok)
      assert.deepEqual(encoded.data.canonicalBytes, decoded.data.canonicalBytes, entry.path);
  }
});

test('rejects every invalid fixture with exact catalog metadata', async () => {
  for (const entry of FIXTURE_CATALOG) {
    if (entry.kind !== 'invalid') continue;
    const result = parsers[entry.schema].parse(await loadFixture(entry.path));
    assert.equal(result.ok, false, entry.path);
    if (result.ok) continue;
    assert.equal(result.error.code, entry.expectedErrorCode, entry.path);
    assert.deepEqual(result.error.details, entry.expectedDetails, entry.path);
    const actualPath =
      result.error.details !== null && 'path' in result.error.details
        ? result.error.details.path
        : null;
    assert.deepEqual(actualPath, entry.expectedPath, entry.path);
    const encoded = parsers[entry.schema].parseBytes(await loadFixtureBytes(entry.path));
    assert.equal(encoded.ok, false, `${entry.path} bytes`);
    if (!encoded.ok)
      assert.deepEqual(encoded.error, result.error, `${entry.path} decoded/bytes equivalence`);
  }
});

test('canonicalizes scalar-key order, negative zero, and Unicode without normalization', () => {
  const result = canonicalizeJsonV1({ '\u{10000}': -0, '\ue000': 'e\u0301', a: ',' });
  assert.equal(result.ok, true);
  if (result.ok)
    assert.equal(new TextDecoder().decode(result.data.canonicalBytes), '{"a":",","":"é","𐀀":0}');
});

test('fails safely for non-JSON values and hostile nesting', () => {
  const values: unknown[] = [undefined, 1n, new Date(), new Map(), [, 1]];
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  values.push(cyclic);
  for (const value of values)
    assert.doesNotThrow(() => assert.equal(canonicalizeJsonV1(value).ok, false));
});

test('keeps the generic JSON depth ceiling reachable at exactly sixty-four', () => {
  let atLimit: unknown = null;
  for (let index = 1; index < 64; index += 1) atLimit = [atLimit];
  assert.equal(canonicalizeJsonV1(atLimit).ok, true);
  const overLimit = [atLimit];
  const result = canonicalizeJsonV1(overLimit);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'LIMIT_EXCEEDED');
});

test('applies raw framing checks before decoded parsing', () => {
  const malformedUtf8 = SceneParserV1.parseBytes(new Uint8Array([0xc3, 0x28]));
  assert.equal(malformedUtf8.ok, false);
  const duplicate = SceneParserV1.parseBytes(
    new TextEncoder().encode('{"protocolVersion":1,"type":"scene","root":null,"root":null}'),
  );
  assert.equal(duplicate.ok, false);
  const whitespace = new Uint8Array(1_048_577).fill(0x20);
  const oversized = SceneParserV1.parseBytes(whitespace);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, 'PAYLOAD_TOO_LARGE');
});

test('keeps the generic JSON fan-out ceiling reachable and rejects one over', () => {
  const atLimit = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, index) => [`key${index}`, index]),
  );
  assert.equal(canonicalizeJsonV1(atLimit).ok, true);
  const overLimit = { ...atLimit, key10000: 10_000 };
  const result = canonicalizeJsonV1(overLimit);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.deepEqual(result.error.details, {
      limit: 'maxJsonContainerEntries',
      actual: 10_001,
      maximum: 10_000,
      path: [],
    });
});

test('never invokes accessors or throws for a deeply hostile decoded value', () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return 'unsafe';
    },
  });
  const accessorResult = canonicalizeJsonV1(accessor);
  assert.equal(accessorResult.ok, false);
  assert.equal(getterCalls, 0);

  const hidden = {};
  Object.defineProperty(hidden, 'value', { value: 'hidden', enumerable: false });
  assert.equal(canonicalizeJsonV1(hidden).ok, false);

  let hostile: unknown = null;
  for (let index = 0; index < 20_000; index += 1) hostile = [hostile];
  assert.doesNotThrow(() => {
    const result = canonicalizeJsonV1(hostile);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'LIMIT_EXCEEDED');
  });
});

test('all public parsers return errors as values for unsafe input and malformed bytes', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const malformed = new Uint8Array([0xc3, 0x28]);
  for (const [name, parser] of Object.entries(parsers)) {
    assert.doesNotThrow(() => assert.equal(parser.parse(cycle).ok, false), name);
    assert.doesNotThrow(
      () => assert.equal(parser.parseBytes(malformed).ok, false),
      `${name} bytes`,
    );
  }
});

test('documents the intentional raw-only framing divergence', async () => {
  const semantic = await loadFixture('valid/scene-empty.v1.json');
  assert.equal(SceneParserV1.parse(semantic).ok, true);
  const source = new TextEncoder().encode(JSON.stringify(semantic));
  const atLimit = new Uint8Array(1_048_576);
  atLimit.fill(0x20, 0, atLimit.length - source.length);
  atLimit.set(source, atLimit.length - source.length);
  assert.equal(SceneParserV1.parseBytes(atLimit).ok, true);
  assert.equal(SceneParserV1.parseBytes(new Uint8Array(1_048_577).fill(0x20)).ok, false);
  assert.equal(
    SceneParserV1.parseBytes(
      new TextEncoder().encode('{"protocolVersion":1,"type":"scene","root":null,"root":null}'),
    ).ok,
    false,
  );
  assert.equal(SceneParserV1.parseBytes(new TextEncoder().encode('{')).ok, false);
});
