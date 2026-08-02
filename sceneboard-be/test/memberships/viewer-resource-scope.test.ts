import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ArtifactApplicationService } from '../../src/artifacts/artifact-application.service.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import { InteractionQueryService } from '../../src/interactions/application/interaction-query.service.js';
import { HitlWaitCoordinator } from '../../src/interactions/application/hitl-wait-coordinator.js';
import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';

const viewerContext = {
  membership: {
    boardPk: 50n,
    accountPk: 20n,
    membershipPk: 60n,
    membershipRole: 'viewer',
    membershipVersion: 1,
    operation: 'artifact.get',
    surface: 'browser',
    write: false,
  },
};

const boardNotFound = (error: unknown): boolean =>
  error instanceof BoardContractError && error.boardError.code === 'BOARD_NOT_FOUND';

test('viewer artifact reads fail as BOARD_NOT_FOUND before unreferenced version access', async () => {
  let versionReads = 0;
  const policy = {
    withAuthorizedBoardTransaction: async (
      _input: unknown,
      apply: (connection: unknown, context: unknown) => Promise<unknown>,
    ) =>
      apply(
        {
          execute: async () => [[], []],
        },
        viewerContext,
      ),
  };
  const service = new ArtifactApplicationService(
    policy as never,
    {} as never,
    {
      readVersion: async () => {
        versionReads += 1;
      },
    } as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(
    service.get({
      principal: {} as never,
      request: {
        protocolVersion: 1,
        requestId: 'request_1' as never,
        type: 'artifact.get',
        boardId: 'board_1' as never,
        artifact: { artifactId: 'artifact_1', versionId: 'version_1' } as never,
      },
    }),
    boardNotFound,
  );
  assert.equal(versionReads, 0);
});

test('viewer HITL reads fail as BOARD_NOT_FOUND before unreferenced interaction access', async () => {
  let interactionReads = 0;
  const policy = {
    withAuthorizedBoardTransaction: async (
      _input: unknown,
      apply: (connection: unknown, context: unknown) => Promise<unknown>,
    ) =>
      apply(
        {
          execute: async () => [[], []],
        },
        {
          ...viewerContext,
          membership: { ...viewerContext.membership, operation: 'hitl.read' },
        },
      ),
  };
  const service = new InteractionQueryService(
    policy as never,
    {
      readByPublicId: async () => {
        interactionReads += 1;
      },
    } as never,
    {} as never,
    new HitlWaitCoordinator(),
    () => Date.parse('2026-07-28T00:00:00.000Z'),
    {} as never,
  );
  await assert.rejects(
    service.read(
      {} as never,
      {
        protocolVersion: 1,
        requestId: 'request_1' as never,
        type: 'hitl.read',
        boardId: 'board_1' as never,
        hitlRequestId: 'hitl_1' as never,
        wait: null,
      },
      new AbortController().signal,
    ),
    boardNotFound,
  );
  assert.equal(interactionReads, 0);
});

test('viewer scope admits artifact and HITL references from the authorized current head', async () => {
  const artifactService = new ArtifactApplicationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const artifactProbe = artifactService as unknown as {
    assertViewerCurrentHeadReference(
      connection: unknown,
      context: unknown,
      artifact: unknown,
    ): Promise<void>;
  };
  await artifactProbe.assertViewerCurrentHeadReference(
    {
      execute: async () => [[{ admitted: 1 }], []],
    },
    viewerContext,
    { artifactId: 'artifact_1', versionId: 'version_1' },
  );

  const checkpoints = new DocumentCheckpointCodec();
  const checkpoint = await checkpoints.encodeScene({
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: 'hitl',
      type: 'content.hitl',
      hitlRequestId: 'hitl_1',
    },
  });
  const interactionService = new InteractionQueryService(
    {} as never,
    {} as never,
    {} as never,
    new HitlWaitCoordinator(),
    () => Date.parse('2026-07-28T00:00:00.000Z'),
    checkpoints,
  );
  const hitlProbe = interactionService as unknown as {
    assertViewerCurrentHeadReference(
      connection: unknown,
      context: unknown,
      hitlRequestId: string,
    ): Promise<void>;
  };
  const checkpointQueries: string[] = [];
  await hitlProbe.assertViewerCurrentHeadReference(
    {
      execute: async (sql: string) => {
        checkpointQueries.push(sql.replace(/\s+/g, ' ').trim());
        return [
          [
            {
              schemaVersion: checkpoint.schemaVersion,
              codec: checkpoint.codec,
              payload: checkpoint.payload,
              canonicalBytes: checkpoint.canonicalBytes,
              storedBytes: checkpoint.storedBytes,
              sha256: checkpoint.sha256,
            },
          ],
          [],
        ];
      },
    },
    {
      ...viewerContext,
      membership: { ...viewerContext.membership, operation: 'hitl.read' },
    },
    'hitl_1',
  );
  const sql = checkpointQueries[0] ?? '';
  assert.match(
    sql,
    /LEFT JOIN board_revision_payloads p ON p\.revision_pk = r\.revision_pk AND p\.state = 'available'/u,
  );
  assert.equal((sql.match(/CASE WHEN p\.revision_pk IS NOT NULL/gu) ?? []).length, 6);
});
