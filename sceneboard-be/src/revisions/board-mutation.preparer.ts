import {
  buildMutationFingerprintV1,
  type EventId,
  type MutationRequestV1,
  type RevisionId,
  type SceneV1,
  type TimestampV1,
} from '@sceneboard/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import { generatePublicUuidV4, parsePublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { formatMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { canonicalBytes, digest, internalFailure } from './board-mutation.support.js';
import type { CollisionKind, MutationRuntime, PreparedMutationV1 } from './board-mutation.types.js';
import { extractSceneArtifactReferences } from './scene-artifact-reference.extractor.js';
import { SceneCheckpointCodec } from './scene-checkpoint.codec.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export class BoardMutationPreparer {
  private readonly runtime: MutationRuntime;

  constructor(
    private readonly checkpoints: SceneCheckpointCodec,
    runtime: Partial<MutationRuntime> = {},
  ) {
    this.runtime = {
      now: runtime.now ?? (() => new Date()),
      generateUuid: runtime.generateUuid ?? (() => generatePublicUuidV4()),
    };
  }

  async prepare(input: {
    principal: ResolvedBoardPrincipalV1;
    request: MutationRequestV1;
  }): Promise<PreparedMutationV1> {
    const fingerprint = buildMutationFingerprintV1({
      ...input.request,
      actor: input.principal.actor,
    });
    if (!fingerprint.ok) throw new BoardContractError(fingerprint.error);
    const fingerprintPayload = Buffer.from(fingerprint.data.canonicalBytes);
    const actorScopesPayload = canonicalBytes(input.principal.actor.scopes);
    const commandPayload = canonicalBytes(input.request.command);
    const scopePayload = canonicalBytes({
      scope: 'board.mutation',
      principalKind: input.principal.actor.principalKind,
      principalId: input.principal.actor.principalId,
      boardId: input.request.boardId,
      idempotencyKey: input.request.idempotencyKey,
    });
    const now = this.runtime.now();
    if (!Number.isFinite(now.valueOf())) throw internalFailure();
    const expiresAt = new Date(now.valueOf() + 30 * DAY_MS);
    const revisionUuid = this.runtime.generateUuid();
    const eventUuid = this.runtime.generateUuid();
    const recordUuid = this.runtime.generateUuid();
    let scene: SceneV1 | null = null;
    if (input.request.command.type === 'scene.replace') scene = input.request.command.scene;
    else if (input.request.command.type === 'scene.clear') {
      scene = { protocolVersion: 1, type: 'scene', root: null };
    }
    const checkpoint = scene === null ? null : await this.checkpoints.encode(scene);
    return {
      revisionId: revisionUuid as RevisionId,
      revisionIdBytes: Buffer.from(parsePublicUuidV4(revisionUuid)),
      eventId: eventUuid as EventId,
      eventIdBytes: Buffer.from(parsePublicUuidV4(eventUuid)),
      recordIdBytes: Buffer.from(parsePublicUuidV4(recordUuid)),
      occurredAt: now.toISOString() as TimestampV1,
      occurredAtSql: formatMysqlTimestampUtc(now),
      expiresAtSql: formatMysqlTimestampUtc(expiresAt),
      fingerprintPayload,
      fingerprintSha256: digest(fingerprintPayload),
      actorScopesPayload,
      actorScopesSha256: digest(actorScopesPayload),
      commandPayloadSha256: digest(commandPayload),
      idempotencyScopeSha256: digest(scopePayload),
      checkpoint,
      references: scene === null ? null : extractSceneArtifactReferences(scene),
    };
  }

  regenerate(prepared: PreparedMutationV1, kind: CollisionKind): PreparedMutationV1 {
    const uuid = this.runtime.generateUuid();
    const bytes = Buffer.from(parsePublicUuidV4(uuid));
    if (kind === 'revision') {
      return { ...prepared, revisionId: uuid as RevisionId, revisionIdBytes: bytes };
    }
    if (kind === 'event') {
      return { ...prepared, eventId: uuid as EventId, eventIdBytes: bytes };
    }
    return { ...prepared, recordIdBytes: bytes };
  }
}
