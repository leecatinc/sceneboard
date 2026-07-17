import { Injectable, Logger } from '@nestjs/common';
import {
  BoardEventEnvelopeParserV1,
  BoardOperationResultParserV1,
  MutationRequestParserV1,
  MutationResultParserV1,
  type ArtifactReferenceV1,
  type ArtifactRuntimeSummaryV1,
  type BoardEventEnvelopeV1,
} from '@leecat-board/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import type { BoardAccessPolicy } from '../grants/board-access.policy.js';
import {
  ControlMutationRepository,
  prepareControlMutationV1,
} from '../revisions/control-mutation.repository.js';
import {
  ArtifactApplicationPortV1,
  type ArtifactGetRequestV1,
} from './artifact-application.port.js';
import { encodeArtifactPackageV1 } from './artifact-package.builder.js';
import { ArtifactRepository } from './artifact.repository.js';
import { ArtifactAuditService } from './artifact-audit.service.js';
import { ArtifactSourceNormalizerV1 } from './artifact-source-normalizer.js';

const internalFailure = (): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INTERNAL_ERROR',
  message: 'Internal error',
  category: 'internal',
  retryable: false,
  httpStatusHint: 500,
  details: null,
});

const artifactNotFound = (artifact: ArtifactReferenceV1): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'ARTIFACT_NOT_FOUND',
  message: 'Artifact not found',
  category: 'not_found',
  retryable: false,
  httpStatusHint: 404,
  details: { artifact },
});

const event = (input: {
  boardId: string;
  eventId: string;
  sequence: number;
  occurredAt: string;
  runtime: ArtifactRuntimeSummaryV1;
}): BoardEventEnvelopeV1 => {
  const parsed = BoardEventEnvelopeParserV1.parse({
    protocolVersion: 1,
    type: 'board.event',
    boardId: input.boardId,
    eventId: input.eventId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    revisionId: null,
    data: { type: 'artifact.status.changed', artifact: input.runtime },
  });
  if (!parsed.ok) throw internalFailure();
  return parsed.data.value;
};

@Injectable()
export class ArtifactApplicationService extends ArtifactApplicationPortV1 {
  private readonly logger = new Logger(ArtifactApplicationService.name);

  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly normalizer: ArtifactSourceNormalizerV1,
    private readonly artifacts: ArtifactRepository,
    private readonly mutations: ControlMutationRepository,
    private readonly audit: ArtifactAuditService,
  ) {
    super();
  }

  async publish(input: Parameters<ArtifactApplicationPortV1['publish']>[0]) {
    let stage = 'normalize';
    const publication = this.normalizer.normalize({ principal: input.principal, source: input.source });
    stage = 'request-parse';
    const request = MutationRequestParserV1.parse({
      protocolVersion: 1,
      requestId: input.requestId,
      idempotencyKey: input.source.idempotencyKey,
      boardId: input.source.boardId,
      expectedRevisionId: input.source.expectedRevisionId,
      command: { type: 'artifact.publish', manifest: publication.manifest },
    });
    if (!request.ok) throw new BoardContractError(request.error);
    if (request.data.value.command.type !== 'artifact.publish') throw internalFailure();
    const prepared = prepareControlMutationV1({ principal: input.principal, request: request.data.value });
    stage = 'authorization';
    return this.accessPolicy.withAuthorizedBoardTransaction({
      principal: input.principal,
      operation: 'artifact.publish',
      boardId: input.source.boardId,
      isolation: 'READ_COMMITTED_WRITE',
    }, async (connection, context) => {
      for (const capability of publication.manifest.requestedCapabilities) {
        if (!context.artifactCapabilityPolicy.allowedArtifactRequestCapabilities.includes(capability)) {
          throw new BoardContractError({
            protocolVersion: 1,
            type: 'board.error',
            code: 'CAPABILITY_DENIED',
            message: 'Capability denied',
            category: 'auth',
            retryable: false,
            httpStatusHint: 403,
            details: { capability },
          });
        }
      }
      stage = 'admission';
      const admission = await this.mutations.begin(connection, context, request.data.value, prepared);
      if (admission.kind === 'replay') return admission.result;
      stage = 'head-lock';
      const head = await this.mutations.lockHead(connection, request.data.value);
      stage = 'sequence';
      const sequence = await this.mutations.allocateSequence(connection, head, prepared);
      stage = 'artifact-persistence';
      const runtime = await this.artifacts.publish(connection, {
        head,
        context,
        requestId: input.requestId,
        publication,
        artifactIdWasSupplied: input.source.artifactId !== null,
        sequence,
        occurredAtSql: prepared.occurredAtSql,
      });
      const publishedEvent = event({
        boardId: input.source.boardId,
        eventId: prepared.eventId,
        sequence,
        occurredAt: prepared.occurredAt,
        runtime,
      });
      stage = 'event-append';
      await this.mutations.appendEvent(connection, head, publishedEvent);
      stage = 'result-parse';
      const result = MutationResultParserV1.parse({
        protocolVersion: 1,
        type: 'mutation.result',
        requestId: input.requestId,
        boardId: input.source.boardId,
        replayed: false,
        eventIds: [prepared.eventId],
        result: { type: 'artifact.publish', artifact: runtime },
      });
      if (!result.ok) throw internalFailure();
      stage = 'completion';
      const completed = await this.mutations.complete(
        connection, admission.recordPk, head, prepared, result.data.value,
      );
      stage = 'audit';
      await this.audit.write(connection, {
        event: 'artifact.publication.created',
        context,
        boardPk: head.boardPk,
        operation: 'publish',
        status: 'ready',
        eventSequence: sequence,
        resultCode: 'success',
      });
      return completed;
    }).catch((error: unknown) => {
      const code = error !== null && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
        ? error.code
        : error instanceof BoardContractError ? error.boardError.code : 'UNKNOWN';
      this.logger.error(`Artifact publication failed safely at ${stage} (${code})`);
      throw error;
    });
  }

  async get(input: Parameters<ArtifactApplicationPortV1['get']>[0]) {
    return this.accessPolicy.withAuthorizedBoardTransaction({
      principal: input.principal,
      operation: 'artifact.get',
      boardId: input.request.boardId,
      isolation: 'REPEATABLE_READ_CUT',
    }, async (connection, context) => {
      const stored = await this.artifacts.readVersion(
        connection, input.request.boardId, input.request.artifact, false,
      );
      const result = BoardOperationResultParserV1.parse({
        protocolVersion: 1,
        type: 'board.operation.result',
        requestId: input.request.requestId,
        replayed: false,
        result: { type: 'artifact.get', manifest: stored.manifest, runtime: stored.runtime },
      });
      if (!result.ok) throw internalFailure();
      await this.audit.write(connection, {
        event: 'artifact.metadata.read',
        context,
        boardPk: stored.boardPk,
        versionPk: stored.versionPk,
        operation: 'metadata',
        status: stored.runtime.status === 'ready' ? 'ready' : 'stopped',
        eventSequence: stored.lastEventSequence,
        resultCode: 'success',
      });
      return result.data.value;
    });
  }

  async getPackage(input: Parameters<ArtifactApplicationPortV1['getPackage']>[0]): Promise<Buffer> {
    return this.accessPolicy.withAuthorizedBoardTransaction({
      principal: input.principal,
      operation: 'artifact.get',
      boardId: input.request.boardId,
      isolation: 'REPEATABLE_READ_CUT',
    }, async (connection, context) => {
      const stored = await this.artifacts.readVersion(
        connection, input.request.boardId, input.request.artifact, true,
      );
      if (stored.runtime.status !== 'ready') throw artifactNotFound(input.request.artifact);
      const bytes = encodeArtifactPackageV1(stored.manifestBytes, stored.resources);
      await this.audit.write(connection, {
        event: 'artifact.package.read',
        context,
        boardPk: stored.boardPk,
        versionPk: stored.versionPk,
        operation: 'package',
        status: 'ready',
        eventSequence: stored.lastEventSequence,
        resultCode: 'success',
      });
      return bytes;
    });
  }

  async stop(input: Parameters<ArtifactApplicationPortV1['stop']>[0]) {
    const parsed = MutationRequestParserV1.parse(input.request);
    if (!parsed.ok) throw new BoardContractError(parsed.error);
    if (parsed.data.value.command.type !== 'artifact.stop') throw internalFailure();
    const request = parsed.data.value as typeof input.request;
    const prepared = prepareControlMutationV1({ principal: input.principal, request });
    return this.accessPolicy.withAuthorizedBoardTransaction({
      principal: input.principal,
      operation: 'artifact.stop',
      boardId: request.boardId,
      isolation: 'READ_COMMITTED_WRITE',
    }, async (connection, context) => {
      const admission = await this.mutations.begin(connection, context, request, prepared);
      if (admission.kind === 'replay') return admission.result;
      const head = await this.mutations.lockHead(connection, request);
      const stored = await this.artifacts.lockRuntime(connection, head.boardPk, request.command.artifact);
      if (stored.runtime.status !== 'ready' && stored.runtime.status !== 'stopped') throw internalFailure();
      let runtime = stored.runtime;
      let eventIds: string[] = [];
      let eventSequence = stored.lastEventSequence;
      if (stored.runtime.status === 'ready') {
        const sequence = await this.mutations.allocateSequence(connection, head, prepared);
        await this.artifacts.markStopped(connection, stored.versionPk, sequence, prepared.occurredAtSql);
        runtime = { ...stored.runtime, status: 'stopped', updatedAt: prepared.occurredAt, failure: null };
        const stoppedEvent = event({
          boardId: request.boardId,
          eventId: prepared.eventId,
          sequence,
          occurredAt: prepared.occurredAt,
          runtime,
        });
        await this.mutations.appendEvent(connection, head, stoppedEvent);
        eventIds = [prepared.eventId];
        eventSequence = sequence;
      }
      const result = MutationResultParserV1.parse({
        protocolVersion: 1,
        type: 'mutation.result',
        requestId: request.requestId,
        boardId: request.boardId,
        replayed: false,
        eventIds,
        result: { type: 'artifact.stop', artifact: runtime },
      });
      if (!result.ok) throw internalFailure();
      const completed = await this.mutations.complete(
        connection, admission.recordPk, head, prepared, result.data.value,
      );
      await this.audit.write(connection, {
        event: 'artifact.runtime.stopped',
        context,
        boardPk: head.boardPk,
        versionPk: stored.versionPk,
        operation: 'stop',
        status: 'stopped',
        eventSequence,
        resultCode: 'success',
      });
      return completed;
    });
  }
}
