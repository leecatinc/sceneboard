import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  ArtifactManifestParserV1,
  ArtifactResourceParserV1,
  BOARD_LIMITS_V1,
  BoardCapabilitiesParserV1,
  BoardEventEnvelopeParserV1,
  BoardOperationResultParserV1,
  BoardSnapshotParserV1,
  HitlInteractionParserV1,
  HitlRequestDefinitionParserV1,
  HitlResponseParserV1,
  MutationEnvelopeParserV1,
  MutationRequestParserV1,
  MutationResultParserV1,
  type BoardContractParserV1,
  type BoardParseResultV1,
} from '../src/index.js';
import { loadFixture } from './helpers/load-fixture.js';

type JsonRecord = Record<string, unknown>;

const expectLimit = (
  result: BoardParseResultV1<unknown>,
  limit: string,
  path: Array<string | number>,
): void => {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'LIMIT_EXCEEDED');
  assert.equal(
    result.error.details !== null && 'limit' in result.error.details
      ? result.error.details.limit
      : null,
    limit,
  );
  assert.deepEqual(
    result.error.details !== null && 'path' in result.error.details
      ? result.error.details.path
      : null,
    path,
  );
};

test('requires normalized artifact paths and sorted unique capabilities', async () => {
  const valid = await loadFixture('valid/artifact-manifest.v1.json');
  assert.equal(ArtifactManifestParserV1.parse(valid).ok, true);
  const reordered = structuredClone(valid) as { requestedCapabilities: string[] };
  reordered.requestedCapabilities = [...ARTIFACT_REQUEST_CAPABILITIES_V1].reverse();
  assert.equal(ArtifactManifestParserV1.parse(reordered).ok, false);
  assert.equal(
    ArtifactManifestParserV1.parse({ ...(valid as object), entryPath: '../index.html' }).ok,
    false,
  );
});

test('correlates HITL definitions, responses, and terminal chronology', async () => {
  assert.equal(
    HitlRequestDefinitionParserV1.parse(await loadFixture('valid/hitl-request-form.v1.json')).ok,
    true,
  );
  assert.equal(
    HitlResponseParserV1.parse(await loadFixture('valid/hitl-response-form.v1.json')).ok,
    true,
  );
  assert.equal(
    HitlInteractionParserV1.parse(await loadFixture('valid/hitl-interaction-answered.v1.json')).ok,
    true,
  );
  assert.equal(
    HitlInteractionParserV1.parse(await loadFixture('invalid/hitl-answered-before-created.v1.json'))
      .ok,
    false,
  );
});

test('keeps standalone response validation structural', () => {
  const response = { kind: 'form', values: { fieldA: 42 } };
  assert.equal(HitlResponseParserV1.parse(response).ok, true);
  const interaction = {
    hitlRequestId: 'hitl_1',
    definition: {
      kind: 'form',
      title: 'Form',
      fields: [
        {
          id: 'fieldA',
          type: 'text',
          label: 'Text',
          required: true,
          defaultValue: null,
          minLength: 1,
          maxLength: 10,
        },
      ],
      submitLabel: 'Submit',
    },
    state: 'answered',
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: null,
    stateUpdatedAt: '2026-07-16T00:01:00.000Z',
    response,
    answeredAt: '2026-07-16T00:01:00.000Z',
  };
  assert.equal(HitlInteractionParserV1.parse(interaction).ok, false);
});

test('advertises exact frozen catalogs and limits', async () => {
  const capabilities = await loadFixture('valid/capabilities-default.v1.json');
  assert.equal(BoardCapabilitiesParserV1.parse(capabilities).ok, true);
  const changed = structuredClone(capabilities) as { limits: { maxSceneNodes: number } };
  changed.limits.maxSceneNodes += 1;
  assert.equal(BoardCapabilitiesParserV1.parse(changed).ok, false);
});

test('keeps HITL option and text ceilings reachable and rejects one over', () => {
  const options = Array.from({ length: 50 }, (_, index) => ({
    id: `option${index}`,
    label: `Option ${index}`,
  }));
  const atLimit = {
    kind: 'choice',
    title: 'Choose',
    multiple: true,
    minSelections: 1,
    maxSelections: 50,
    options,
  };
  assert.equal(HitlRequestDefinitionParserV1.parse(atLimit).ok, true);
  const optionOver = HitlRequestDefinitionParserV1.parse({
    ...atLimit,
    maxSelections: 50,
    options: [...options, { id: 'option50', label: 'Option 50' }],
  });
  assert.equal(optionOver.ok, false);
  if (!optionOver.ok) assert.equal(optionOver.error.code, 'LIMIT_EXCEEDED');

  const textAtLimit = HitlResponseParserV1.parse({
    kind: 'form',
    values: { text: 'a'.repeat(60_000) },
  });
  assert.equal(textAtLimit.ok, true);
  const textOver = HitlResponseParserV1.parse({
    kind: 'form',
    values: { text: 'a'.repeat(60_001) },
  });
  assert.equal(textOver.ok, false);
  if (!textOver.ok) assert.equal(textOver.error.code, 'LIMIT_EXCEEDED');
});

test('keeps artifact resource, manifest total, and resource-count limits reachable', async () => {
  const resource = (await loadFixture('valid/artifact-resource.v1.json')) as JsonRecord;
  assert.equal(
    ArtifactResourceParserV1.parse({
      ...resource,
      byteLength: BOARD_LIMITS_V1.maxArtifactResourceBytes,
    }).ok,
    true,
  );
  expectLimit(
    ArtifactResourceParserV1.parse({
      ...resource,
      byteLength: BOARD_LIMITS_V1.maxArtifactResourceBytes + 1,
    }),
    'maxArtifactResourceBytes',
    ['byteLength'],
  );

  const manifest = (await loadFixture('valid/artifact-manifest.v1.json')) as JsonRecord;
  const makeResource = (index: number, byteLength: number) => ({
    path: `resource${index}.bin`,
    mediaType: 'application/octet-stream',
    sha256: String(index).padStart(64, '0'),
    byteLength,
  });
  const atTotal = {
    ...manifest,
    entryPath: 'resource0.bin',
    resources: [
      makeResource(0, BOARD_LIMITS_V1.maxArtifactResourceBytes),
      makeResource(1, BOARD_LIMITS_V1.maxArtifactResourceBytes),
    ],
  };
  assert.equal(ArtifactManifestParserV1.parse(atTotal).ok, true);
  const overTotal = { ...atTotal, resources: [...atTotal.resources, makeResource(2, 1)] };
  const totalResult = ArtifactManifestParserV1.parse(overTotal);
  expectLimit(totalResult, 'maxArtifactTotalBytes', ['resources']);
  if (!totalResult.ok)
    assert.deepEqual(totalResult.error.details, {
      limit: 'maxArtifactTotalBytes',
      actual: 10_485_761,
      maximum: 10_485_760,
      path: ['resources'],
    });

  const atCount = {
    ...manifest,
    entryPath: 'resource0.bin',
    resources: Array.from({ length: BOARD_LIMITS_V1.maxArtifactResources }, (_, index) =>
      makeResource(index, 0),
    ),
  };
  assert.equal(ArtifactManifestParserV1.parse(atCount).ok, true);
  expectLimit(
    ArtifactManifestParserV1.parse({
      ...atCount,
      resources: [...atCount.resources, makeResource(BOARD_LIMITS_V1.maxArtifactResources, 0)],
    }),
    'maxArtifactResources',
    ['resources'],
  );
});

test('applies definition option and field limits through every public HITL carrier', async (context) => {
  const request = (await loadFixture('valid/mutation-request-hitl-request.v1.json')) as JsonRecord;
  const envelope = (await loadFixture(
    'valid/mutation-envelope-hitl-request.v1.json',
  )) as JsonRecord;
  const mutationResult = (await loadFixture(
    'valid/mutation-result-hitl-request.v1.json',
  )) as JsonRecord;
  const operationResult = (await loadFixture(
    'valid/operation-result-hitl-read.v1.json',
  )) as JsonRecord;
  const snapshot = (await loadFixture('valid/snapshot-board.v1.json')) as JsonRecord;
  const event = (await loadFixture('valid/event-hitl-updated.v1.json')) as JsonRecord;
  const open = asOpenInteraction((mutationResult.result as JsonRecord).hitl);

  const makeChoice = (count: number) => ({
    kind: 'choice',
    title: 'Choose',
    multiple: true,
    minSelections: 1,
    maxSelections: Math.min(count, BOARD_LIMITS_V1.maxHitlOptions),
    options: Array.from({ length: count }, (_, index) => ({
      id: `option${index}`,
      label: `Option ${index}`,
    })),
  });
  const makeForm = (count: number) => ({
    kind: 'form',
    title: 'Form',
    fields: Array.from({ length: count }, (_, index) => ({
      id: `field${index}`,
      type: 'boolean',
      label: `Field ${index}`,
      required: false,
      defaultValue: null,
    })),
    submitLabel: 'Submit',
  });

  for (const [name, makeDefinition, limit, suffix] of [
    ['choice options', makeChoice, 'maxHitlOptions', ['options']],
    ['form fields', makeForm, 'maxHitlFields', ['fields']],
  ] as const) {
    const maximum =
      limit === 'maxHitlOptions' ? BOARD_LIMITS_V1.maxHitlOptions : BOARD_LIMITS_V1.maxHitlFields;
    const carriers = (
      definition: unknown,
    ): Array<[BoardContractParserV1<unknown>, unknown, Array<string | number>]> => {
      const interaction = { ...open, definition };
      const pathSuffix = [...suffix];
      return [
        [HitlRequestDefinitionParserV1, definition, pathSuffix],
        [
          MutationRequestParserV1,
          { ...request, command: { ...(request.command as object), request: definition } },
          ['command', 'request', ...pathSuffix],
        ],
        [
          MutationEnvelopeParserV1,
          { ...envelope, command: { ...(envelope.command as object), request: definition } },
          ['command', 'request', ...pathSuffix],
        ],
        [
          MutationResultParserV1,
          {
            ...mutationResult,
            result: { ...(mutationResult.result as object), hitl: interaction },
          },
          ['result', 'hitl', 'definition', ...pathSuffix],
        ],
        [
          BoardOperationResultParserV1,
          {
            ...operationResult,
            result: { ...(operationResult.result as object), hitl: interaction },
          },
          ['result', 'hitl', 'definition', ...pathSuffix],
        ],
        [
          BoardSnapshotParserV1,
          { ...snapshot, hitl: [interaction] },
          ['hitl', 0, 'definition', ...pathSuffix],
        ],
        [
          BoardEventEnvelopeParserV1,
          { ...event, data: { ...(event.data as object), hitl: interaction } },
          ['data', 'hitl', 'definition', ...pathSuffix],
        ],
      ];
    };
    await context.test(name, () => {
      for (const [parser, input] of carriers(makeDefinition(maximum)))
        assert.equal(parser.parse(input).ok, true);
      for (const [parser, input, path] of carriers(makeDefinition(maximum + 1)))
        expectLimit(parser.parse(input), limit, path);
    });
  }
});

test('applies response option, value-key, text, and byte limits through every public HITL carrier', async () => {
  const request = (await loadFixture('valid/mutation-request-hitl-respond.v1.json')) as JsonRecord;
  const envelope = (await loadFixture(
    'valid/mutation-envelope-hitl-respond.v1.json',
  )) as JsonRecord;
  const mutationResult = (await loadFixture(
    'valid/mutation-result-hitl-respond.v1.json',
  )) as JsonRecord;
  const operationResult = (await loadFixture(
    'valid/operation-result-hitl-read.v1.json',
  )) as JsonRecord;
  const snapshot = (await loadFixture('valid/snapshot-board.v1.json')) as JsonRecord;
  const event = (await loadFixture('valid/event-hitl-updated.v1.json')) as JsonRecord;
  const answered = asAnsweredInteraction((mutationResult.result as JsonRecord).hitl);

  const carriers = (
    definition: unknown,
    response: unknown,
    suffix: Array<string | number>,
  ): Array<[BoardContractParserV1<unknown>, unknown, Array<string | number>]> => {
    const interaction = { ...answered, definition, response };
    return [
      [HitlResponseParserV1, response, suffix],
      [
        MutationRequestParserV1,
        { ...request, command: { ...(request.command as object), response } },
        ['command', 'response', ...suffix],
      ],
      [
        MutationEnvelopeParserV1,
        { ...envelope, command: { ...(envelope.command as object), response } },
        ['command', 'response', ...suffix],
      ],
      [
        MutationResultParserV1,
        { ...mutationResult, result: { ...(mutationResult.result as object), hitl: interaction } },
        ['result', 'hitl', 'response', ...suffix],
      ],
      [
        BoardOperationResultParserV1,
        {
          ...operationResult,
          result: { ...(operationResult.result as object), hitl: interaction },
        },
        ['result', 'hitl', 'response', ...suffix],
      ],
      [
        BoardSnapshotParserV1,
        { ...snapshot, hitl: [interaction] },
        ['hitl', 0, 'response', ...suffix],
      ],
      [
        BoardEventEnvelopeParserV1,
        { ...event, data: { ...(event.data as object), hitl: interaction } },
        ['data', 'hitl', 'response', ...suffix],
      ],
    ];
  };

  const options = Array.from({ length: BOARD_LIMITS_V1.maxHitlOptions }, (_, index) => ({
    id: `option${index}`,
    label: `Option ${index}`,
  }));
  const choiceDefinition = {
    kind: 'choice',
    title: 'Choose',
    multiple: true,
    minSelections: 1,
    maxSelections: BOARD_LIMITS_V1.maxHitlOptions,
    options,
  };
  const choiceAt = { kind: 'choice', selectedOptionIds: options.map((option) => option.id) };
  const choiceOver = {
    kind: 'choice',
    selectedOptionIds: [...choiceAt.selectedOptionIds, 'option50'],
  };
  for (const [parser, input] of carriers(choiceDefinition, choiceAt, ['selectedOptionIds']))
    assert.equal(parser.parse(input).ok, true);
  for (const [parser, input, path] of carriers(choiceDefinition, choiceOver, ['selectedOptionIds']))
    expectLimit(parser.parse(input), 'maxHitlOptions', path);

  const fields = Array.from({ length: BOARD_LIMITS_V1.maxHitlFields }, (_, index) => ({
    id: `field${index}`,
    type: 'boolean',
    label: `Field ${index}`,
    required: false,
    defaultValue: null,
  }));
  const formDefinition = { kind: 'form', title: 'Form', fields, submitLabel: 'Submit' };
  const formAt = {
    kind: 'form',
    values: Object.fromEntries(fields.map((field) => [field.id, null])),
  };
  const formOver = { kind: 'form', values: { ...formAt.values, field50: null } };
  for (const [parser, input] of carriers(formDefinition, formAt, ['values']))
    assert.equal(parser.parse(input).ok, true);
  for (const [parser, input, path] of carriers(formDefinition, formOver, ['values']))
    expectLimit(parser.parse(input), 'maxHitlFields', path);

  const textDefinition = {
    kind: 'form',
    title: 'Form',
    fields: [
      {
        id: 'text',
        type: 'text',
        label: 'Text',
        required: true,
        defaultValue: null,
        minLength: 0,
        maxLength: BOARD_LIMITS_V1.maxHitlTextChars,
      },
    ],
    submitLabel: 'Submit',
  };
  const textAt = { kind: 'form', values: { text: 'a'.repeat(BOARD_LIMITS_V1.maxHitlTextChars) } };
  const textOver = {
    kind: 'form',
    values: { text: 'a'.repeat(BOARD_LIMITS_V1.maxHitlTextChars + 1) },
  };
  for (const [parser, input] of carriers(textDefinition, textAt, ['values', 'text']))
    assert.equal(parser.parse(input).ok, true);
  for (const [parser, input, path] of carriers(textDefinition, textOver, ['values', 'text']))
    expectLimit(parser.parse(input), 'maxHitlTextChars', path);

  const byteAt = { kind: 'form', values: { text: 'é'.repeat(32_750) } };
  const byteOver = { kind: 'form', values: { text: `${byteAt.values.text}é` } };
  for (const [parser, input] of carriers(textDefinition, byteAt, []))
    assert.equal(parser.parse(input).ok, true);
  for (const [parser, input] of carriers(textDefinition, byteOver, [])) {
    const result = parser.parse(input);
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.deepEqual(result.error.details, {
        scope: 'hitl.response',
        actualBytes: 65_538,
        maximumBytes: BOARD_LIMITS_V1.maxHitlResponseBytes,
      });
  }

  const multibyte = HitlResponseParserV1.parse({
    kind: 'form',
    values: { text: '𐀀'.repeat(17_000) },
  });
  assert.equal(multibyte.ok, false);
  if (!multibyte.ok)
    assert.deepEqual(multibyte.error.details, {
      scope: 'hitl.response',
      actualBytes: 68_036,
      maximumBytes: BOARD_LIMITS_V1.maxHitlResponseBytes,
    });
});

test('maps HITL text-bound declarations to stable limit paths', () => {
  const definition = {
    kind: 'form',
    title: 'Form',
    fields: [
      {
        id: 'text',
        type: 'text',
        label: 'Text',
        required: true,
        defaultValue: null,
        minLength: 0,
        maxLength: BOARD_LIMITS_V1.maxHitlTextChars + 1,
      },
    ],
    submitLabel: 'Submit',
  };
  expectLimit(HitlRequestDefinitionParserV1.parse(definition), 'maxHitlTextChars', [
    'fields',
    0,
    'maxLength',
  ]);
});

function asOpenInteraction(value: unknown): JsonRecord {
  return {
    ...(value as JsonRecord),
    state: 'open',
    stateUpdatedAt: '2026-07-16T00:00:00.000Z',
    response: null,
    answeredAt: null,
  };
}

function asAnsweredInteraction(value: unknown): JsonRecord {
  return {
    ...(value as JsonRecord),
    state: 'answered',
    stateUpdatedAt: '2026-07-16T00:01:00.000Z',
    answeredAt: '2026-07-16T00:01:00.000Z',
  };
}
