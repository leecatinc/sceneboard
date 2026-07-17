import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import * as schema from '../src/index.js';
import type {
  ActorContextV1,
  ActorReferenceV1,
  ArtifactId,
  ArtifactManifestV1,
  ArtifactNodeV1,
  ArtifactReferenceV1,
  ArtifactRequestCapabilityV1,
  ArtifactResourceV1,
  ArtifactRuntimeSummaryV1,
  ArtifactVersionId,
  BoardCapabilitiesV1,
  BoardContractParserV1,
  BoardErrorCodeV1,
  BoardErrorV1,
  BoardEventDataV1,
  BoardEventEnvelopeV1,
  BoardEventTypeV1,
  BoardId,
  BoardLifecycleIdempotencyEnvelopeV1,
  BoardLimitKeyV1,
  BoardMutationCommandTypeV1,
  BoardMutationCommandV1,
  BoardMutationResultDataV1,
  BoardNodeV1,
  BoardOperationEnvelopeV1,
  BoardOperationFingerprintInputV1,
  BoardOperationRequestV1,
  BoardOperationResultDataV1,
  BoardOperationResultV1,
  BoardOperationTypeV1,
  BoardParseResultV1,
  BoardSnapshotV1,
  BoardSummaryV1,
  CanonicalContractValueV1,
  CanvasNodeV1,
  ChartNodeV1,
  ClientGrantCapabilityV1,
  CodeNodeV1,
  ContentText,
  DrawingElementV1,
  DrawingNodeV1,
  DrawingStyleV1,
  EventId,
  GrantId,
  GridNodeV1,
  HistoryEntryV1,
  HitlFieldV1,
  HitlInteractionV1,
  HitlNodeV1,
  HitlOptionV1,
  HitlRequestDefinitionV1,
  HitlRequestId,
  HitlRequestSuccessV1,
  HitlRespondSuccessV1,
  HitlResponseV1,
  IdempotencyKey,
  IdempotencyKeyReusedDetailsV1,
  ImageNodeV1,
  JsonValue,
  LocalFieldId,
  MapNodeV1,
  MarkdownNodeV1,
  MutationEnvelopeV1,
  MutationFingerprintInputV1,
  MutationRequestV1,
  MutationResultV1,
  NodeBaseV1,
  NodeId,
  NodeTypeV1,
  PageCursorV1,
  PointV1,
  PresenceSummaryV1,
  PrincipalId,
  ProgressNodeV1,
  RequestId,
  RevisionConflictErrorV1,
  RevisionId,
  RevisionOriginTypeV1,
  RevisionSummaryV1,
  SceneV1,
  ShortText,
  SplitNodeV1,
  StatusNodeV1,
  TableNodeV1,
  TabId,
  TabsNodeV1,
  TimestampV1,
} from '../src/index.js';
import * as artifactRuntime from '../../artifact-runtime/src/index.js';
import * as sdk from '../../board-sdk/src/index.js';
import * as ui from '../../board-ui/src/index.js';

type PublicTypeSurfaceV1 = [
  ActorContextV1,
  ActorReferenceV1,
  ArtifactId,
  ArtifactManifestV1,
  ArtifactNodeV1,
  ArtifactReferenceV1,
  ArtifactRequestCapabilityV1,
  ArtifactResourceV1,
  ArtifactRuntimeSummaryV1,
  ArtifactVersionId,
  BoardCapabilitiesV1,
  BoardContractParserV1<SceneV1>,
  BoardErrorCodeV1,
  BoardErrorV1,
  BoardEventDataV1,
  BoardEventEnvelopeV1,
  BoardEventTypeV1,
  BoardId,
  BoardLifecycleIdempotencyEnvelopeV1,
  BoardLimitKeyV1,
  BoardMutationCommandTypeV1,
  BoardMutationCommandV1,
  BoardMutationResultDataV1,
  BoardNodeV1,
  BoardOperationEnvelopeV1,
  BoardOperationFingerprintInputV1,
  BoardOperationRequestV1,
  BoardOperationResultDataV1,
  BoardOperationResultV1,
  BoardOperationTypeV1,
  BoardParseResultV1<SceneV1>,
  BoardSnapshotV1,
  BoardSummaryV1,
  CanonicalContractValueV1<SceneV1>,
  CanvasNodeV1,
  ChartNodeV1,
  ClientGrantCapabilityV1,
  CodeNodeV1,
  ContentText,
  DrawingElementV1,
  DrawingNodeV1,
  DrawingStyleV1,
  EventId,
  GrantId,
  GridNodeV1,
  HistoryEntryV1,
  HitlFieldV1,
  HitlInteractionV1,
  HitlNodeV1,
  HitlOptionV1,
  HitlRequestDefinitionV1,
  HitlRequestId,
  HitlRequestSuccessV1,
  HitlRespondSuccessV1,
  HitlResponseV1,
  IdempotencyKey,
  IdempotencyKeyReusedDetailsV1,
  ImageNodeV1,
  JsonValue,
  LocalFieldId,
  MapNodeV1,
  MarkdownNodeV1,
  MutationEnvelopeV1,
  MutationFingerprintInputV1,
  MutationRequestV1,
  MutationResultV1,
  NodeBaseV1,
  NodeId,
  NodeTypeV1,
  PageCursorV1,
  PointV1,
  PresenceSummaryV1,
  PrincipalId,
  ProgressNodeV1,
  RequestId,
  RevisionConflictErrorV1,
  RevisionId,
  RevisionOriginTypeV1,
  RevisionSummaryV1,
  SceneV1,
  ShortText,
  SplitNodeV1,
  StatusNodeV1,
  TableNodeV1,
  TabId,
  TabsNodeV1,
  TimestampV1,
];

const publicTypeSurfaceV1: PublicTypeSurfaceV1 | null = null;
void publicTypeSurfaceV1;

test('exports guarded parser values through curated facades', () => {
  assert.equal(sdk.SceneParserV1, schema.SceneParserV1);
  assert.equal(ui.BoardSnapshotParserV1, schema.BoardSnapshotParserV1);
  assert.equal(artifactRuntime.ArtifactManifestParserV1, schema.ArtifactManifestParserV1);
  assert.equal(sdk.NODE_TYPES_V1, schema.NODE_TYPES_V1);
  assert.equal(artifactRuntime.ARTIFACT_REQUEST_CAPABILITIES_V1, schema.ARTIFACT_REQUEST_CAPABILITIES_V1);
});

test('exports the guarded scalar parser values required by application adapters', () => {
  assert.equal(typeof schema.GlobalIdStringParserV1.parse, 'function');
  assert.equal(typeof schema.BoardIdParserV1.parse, 'function');
  assert.equal(typeof schema.GrantIdParserV1.parse, 'function');
  assert.equal(typeof schema.PrincipalIdParserV1.parse, 'function');
  assert.equal('BoardIdSchemaV1' in schema, false);
  assert.equal('GlobalIdStringSchemaV1' in schema, false);
});

test('does not leak server-attested builders from public client facades', () => {
  assert.equal('buildMutationFingerprintV1' in sdk, false);
  assert.equal('normalizeActorContextV1' in sdk, false);
  assert.equal('MutationEnvelopeParserV1' in ui, false);
  assert.equal('BoardOperationRequestParserV1' in artifactRuntime, false);
});

test('keeps every curated runtime facade exact', () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    'BOARD_ERROR_CODES_V1',
    'BOARD_EVENT_TYPES_V1',
    'BOARD_MUTATION_COMMAND_TYPES_V1',
    'BOARD_OPERATION_TYPES_V1',
    'BoardCapabilitiesParserV1',
    'BoardErrorParserV1',
    'BoardEventEnvelopeParserV1',
    'BoardOperationRequestParserV1',
    'BoardOperationResultParserV1',
    'BoardSnapshotParserV1',
    'MutationRequestParserV1',
    'MutationResultParserV1',
    'NODE_TYPES_V1',
    'PROTOCOL_SEMVER',
    'PROTOCOL_VERSION',
    'SceneParserV1',
    'canonicalizeJsonV1',
  ].sort());
  assert.deepEqual(Object.keys(ui).sort(), [
    'ArtifactReferenceParserV1',
    'ArtifactRuntimeSummaryParserV1',
    'BoardCapabilitiesParserV1',
    'BoardNodeParserV1',
    'BoardSnapshotParserV1',
    'HitlInteractionParserV1',
    'HitlRequestDefinitionParserV1',
    'HitlResponseParserV1',
    'SceneParserV1',
  ].sort());
  assert.deepEqual(Object.keys(artifactRuntime).sort(), [
    'ARTIFACT_REQUEST_CAPABILITIES_V1',
    'ArtifactManifestParserV1',
    'ArtifactReferenceParserV1',
    'ArtifactResourceParserV1',
    'ArtifactRuntimeSummaryParserV1',
  ].sort());
});

test('imports schema and facades in fresh processes without initialization errors', () => {
  const imports = [
    './packages/board-schema/src/index.ts',
    './packages/board-sdk/src/index.ts',
    './packages/board-ui/src/index.ts',
    './packages/artifact-runtime/src/index.ts',
  ];
  for (const order of [imports, [...imports].reverse()]) {
    const code = `await Promise.all(${JSON.stringify(order)}.map((path) => import(path)));`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], { cwd: new URL('../../../', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
