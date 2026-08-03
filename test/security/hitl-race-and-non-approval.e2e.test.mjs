import { tsImport } from 'tsx/esm/api';

import { registerAuthenticatedBoundaryRows } from './security-catalog.test-helper.mjs';

const backendImportOptions = { tsconfig: '../../sceneboard-be/tsconfig.json' };
const { InteractionRepository } = await tsImport(
  '../../sceneboard-be/src/interactions/persistence/interaction.repository.ts',
  import.meta.url,
  backendImportOptions,
);
const { InteractionCommandService } = await tsImport(
  '../../sceneboard-be/src/interactions/application/interaction-command.service.ts',
  import.meta.url,
  backendImportOptions,
);
const { InteractionLifecycleService } = await tsImport(
  '../../sceneboard-be/src/interactions/application/interaction-lifecycle.service.ts',
  import.meta.url,
  backendImportOptions,
);
const { HitlWaitCoordinator } = await tsImport(
  '../../sceneboard-be/src/interactions/application/hitl-wait-coordinator.ts',
  import.meta.url,
  backendImportOptions,
);

const userPrincipal = {
  kind: 'user',
  actor: {
    principalKind: 'user',
    principalId: 'user_1',
    grantId: null,
    scopes: ['board.hitl.request', 'board.hitl.respond', 'board.read'],
  },
  userPk: 1n,
  sessionPk: 2n,
  familyPublicId: 'family_1',
};
const mcpPrincipal = {
  kind: 'mcp',
  actor: {
    principalKind: 'mcp_client',
    principalId: 'client_1',
    grantId: 'grant_1',
    scopes: ['board.hitl.request', 'board.hitl.respond', 'board.read'],
  },
  ownerUserPk: 1n,
  grantPk: 2n,
  credentialPk: 3n,
  grantId: 'grant_1',
  sourceFamilyPublicId: null,
};
const contextFor = (principal) => ({
  actor: principal.actor,
  ownerUserPk: 1n,
  access:
    principal.kind === 'user'
      ? { kind: 'owner', ownerUserPk: 1n }
      : { kind: 'grant', grantPk: 2n, grantId: 'grant_1' },
  createBinding: null,
  artifactCapabilityPolicy: { allowedArtifactRequestCapabilities: [], policyEpoch: 'epoch' },
});

const definitionFor = (kind, destructive = false) => {
  if (kind === 'choice')
    return {
      kind,
      title: 'Choose',
      multiple: false,
      minSelections: 1,
      maxSelections: 1,
      options: [{ id: 'optionA', label: 'A' }],
    };
  if (kind === 'form')
    return {
      kind,
      title: 'Form',
      fields: [
        {
          id: 'fieldA',
          type: 'boolean',
          label: 'Ready',
          required: true,
          defaultValue: null,
        },
      ],
      submitLabel: 'Submit',
    };
  if (kind === 'confirmation')
    return {
      kind,
      title: 'Confirm',
      body: 'Proceed?',
      impact: destructive ? 'destructive' : 'standard',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
    };
  return { kind: 'info', title: 'Info', body: 'Read', acknowledgeLabel: 'OK' };
};

const responseFor = (kind, confirmed = true) => {
  if (kind === 'choice') return { kind, selectedOptionIds: ['optionA'] };
  if (kind === 'form') return { kind, values: { fieldA: true } };
  if (kind === 'confirmation') return { kind, confirmed };
  return { kind: 'info', acknowledged: true };
};

const storedInteraction = ({
  kind = 'info',
  state = 'open',
  destructive = false,
  createdByMcp = false,
  confirmed = false,
} = {}) => ({
  hitlPk: '1',
  boardPk: '1',
  interaction: {
    hitlRequestId: 'hitl_1',
    definition: definitionFor(kind, destructive),
    state,
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-16T00:15:00.000Z',
    stateUpdatedAt: state === 'open' ? '2026-07-16T00:00:00.000Z' : '2026-07-16T00:01:00.000Z',
    response: state === 'answered' ? responseFor(kind, confirmed) : null,
    answeredAt: state === 'answered' ? '2026-07-16T00:01:00.000Z' : null,
  },
  createdByKind: createdByMcp ? 'M' : 'U',
  createdByPrincipalId: createdByMcp ? 'client_1' : 'user_1',
  createdByGrantId: createdByMcp ? 'grant_1' : null,
  supersededByRequestId: state === 'superseded' ? 'hitl_2' : null,
  createdEventSequence: 1,
  stateEventSequence: state === 'open' ? 1 : 2,
});

const createCasConnection = () => {
  let state = 'open';
  const effects = new Set();
  return {
    effects,
    state: () => state,
    connection: {
      async execute(sql) {
        if (!String(sql).includes('UPDATE board_hitl_interactions')) return [{ affectedRows: 1 }];
        if (state !== 'open') return [{ affectedRows: 0 }];
        if (String(sql).includes("state_code = 'A'")) state = 'answered';
        else if (String(sql).includes("state_code = 'E'")) state = 'expired';
        else if (String(sql).includes("state_code = 'C'")) state = 'cancelled';
        else if (String(sql).includes("state_code = 'S'")) state = 'superseded';
        effects.add(state);
        return [{ affectedRows: 1 }];
      },
    },
  };
};

const transitionWithRepository = async (repository, kind, terminalState) => {
  const store = createCasConnection();
  const stored = storedInteraction({ kind });
  if (terminalState === 'open') {
    const interaction = await repository.create(store.connection, {
      head: { boardPk: '1' },
      context: contextFor(userPrincipal),
      hitlRequestId: 'hitl_1',
      definition: stored.interaction.definition,
      requestId: 'request_1',
      sequence: 1,
      createdAt: stored.interaction.createdAt,
      createdAtSql: '2026-07-16 00:00:00.000',
      expiresAt: stored.interaction.expiresAt,
      expiresAtSql: '2026-07-16 00:15:00.000',
    });
    return { observed: interaction.state, effects: store.effects };
  }
  if (terminalState === 'answered')
    await repository.answer(store.connection, {
      stored,
      context: contextFor(userPrincipal),
      requestId: 'request_2',
      response: responseFor(kind),
      sequence: 2,
      answeredAtSql: '2026-07-16 00:01:00.000',
    });
  else if (terminalState === 'expired')
    await repository.expire(store.connection, { stored, sequence: 2 });
  else if (terminalState === 'cancelled')
    await repository.cancel(store.connection, {
      stored,
      context: contextFor(userPrincipal),
      sequence: 2,
      updatedAtSql: '2026-07-16 00:01:00.000',
    });
  else
    await repository.supersede(store.connection, {
      stored,
      successor: {
        ...storedInteraction({ kind }),
        interaction: { ...stored.interaction, hitlRequestId: 'hitl_2' },
      },
      context: contextFor(userPrincipal),
      sequence: 2,
      updatedAtSql: '2026-07-16 00:01:00.000',
    });
  return { observed: store.state(), effects: store.effects };
};

const commandServiceFor = ({ stored, principal, effects }) => {
  let authoritative = stored;
  const context = contextFor(principal);
  const access = {
    withAuthorizedBoardTransaction: async (_input, apply) => apply({}, context),
  };
  const interactions = {
    lockByBoardPk: async () => authoritative,
    answer: async (_connection, input) => {
      effects.add('answer-persisted');
      authoritative = {
        ...authoritative,
        interaction: {
          ...authoritative.interaction,
          state: 'answered',
          response: input.response,
          answeredAt: input.answeredAtSql.replace(' ', 'T').replace(/(?<!Z)$/u, 'Z'),
        },
      };
    },
  };
  const mutations = {
    begin: async () => ({ kind: 'new', recordPk: 1n }),
    lockHead: async () => ({
      boardPk: '1',
      headRevisionPk: '2',
      headRevisionId: 'revision_1',
      headRevisionNumber: 1,
      lastEventSequence: 1,
    }),
    allocateSequence: async () => 2,
    appendEvent: async () => undefined,
    complete: async (_connection, _pk, _head, _prepared, result) => result,
    abandonPending: async () => undefined,
  };
  return {
    service: new InteractionCommandService(
      access,
      interactions,
      mutations,
      { expireLocked: async () => effects.add('expired') },
      new HitlWaitCoordinator(),
      { writeSuccess: async () => undefined },
      () => new Date('2026-07-16T00:01:00.000Z'),
    ),
    authoritativeLookup: () => authoritative,
  };
};

class AttemptOwnedDestructiveConsumer {
  constructor(effects) {
    this.effects = effects;
  }

  consume(stored, attemptId) {
    const response = stored?.interaction.response;
    if (
      stored?.interaction.state !== 'answered' ||
      stored.interaction.definition.kind !== 'confirmation' ||
      stored.interaction.definition.impact !== 'destructive' ||
      response?.kind !== 'confirmation' ||
      response.confirmed !== true
    )
      return 0;
    this.effects.add(`destructive-effect:${attemptId}`);
    return 1;
  }
}

const applyDestructiveResponse = async ({ stored, principal, confirmed, effects }) => {
  const command = commandServiceFor({ stored, principal, effects });
  try {
    await command.service.apply({
      principal,
      request: {
        protocolVersion: 1,
        requestId: 'request_2',
        idempotencyKey: 'idempotency-key-2',
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        command: {
          type: 'hitl.respond',
          hitlRequestId: 'hitl_1',
          response: { kind: 'confirmation', confirmed },
        },
      },
    });
  } catch {
    // Terminal and absent requests fail closed before the destructive consumer.
  }
  return command.authoritativeLookup();
};

const destructiveBoundary = async (row, fixture) => {
  const stateByCase = {
    ABSENT: null,
    FALSE: 'open',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
    SUPERSEDED: 'superseded',
    'RECONNECT-HISTORY': 'answered',
  };
  const state = stateByCase[row.preconditionState];
  const stored = state
    ? storedInteraction({ state, kind: 'confirmation', destructive: true, createdByMcp: true })
    : null;
  const commandEffects = new Set();
  const destructiveEffects = new Set();
  const commandHandle = fixture.registerOwnerResource({
    owner: 'sceneboard.interaction-command-service',
    resource: { effects: commandEffects },
    cleanup: ({ effects }) => effects.clear(),
    inspectResidue: () => commandEffects.size,
  });
  const consumer = new AttemptOwnedDestructiveConsumer(destructiveEffects);
  const consumerHandle = fixture.registerOwnerResource({
    owner: 'sceneboard.destructive-effect-consumer',
    resource: { effects: destructiveEffects, consumer },
    cleanup: ({ effects }) => effects.clear(),
    inspectResidue: () => destructiveEffects.size,
  });
  const authoritative = await fixture.operate(
    commandHandle,
    'hitl.destructive-command',
    ({ effects }) =>
      applyDestructiveResponse({
        stored,
        principal: mcpPrincipal,
        confirmed: row.preconditionState !== 'FALSE',
        effects,
      }),
  );
  const deniedCount = await fixture.operate(
    consumerHandle,
    'hitl.destructive-consume-denied',
    ({ consumer }) => consumer.consume(authoritative, row.caseId),
  );

  const positiveCommandEffects = new Set();
  const approved = await applyDestructiveResponse({
    stored: storedInteraction({ kind: 'confirmation', destructive: true }),
    principal: userPrincipal,
    confirmed: true,
    effects: positiveCommandEffects,
  });
  const positiveCount = await fixture.operate(
    consumerHandle,
    'hitl.destructive-consume-approved-control',
    ({ consumer }) => consumer.consume(approved, `${row.caseId}:approved-control`),
  );
  positiveCommandEffects.clear();
  if (deniedCount !== 0 || positiveCount !== 1) return 'DESTRUCTIVE_APPROVAL_OBSERVED';
  return 'NO_DESTRUCTIVE_APPROVAL';
};

const lifecycleBoundary = async (row, effects) => {
  const replay = row.preconditionState === 'RECONNECT-REPLAY';
  const terminal = row.preconditionState === 'PINNED-HISTORY' || replay;
  const stored = storedInteraction({ state: terminal ? 'cancelled' : 'open' });
  const context = contextFor(userPrincipal);
  const service = new InteractionLifecycleService(
    { withAuthorizedBoardTransaction: async (_input, apply) => apply({}, context) },
    {
      lockByBoardPk: async () => stored,
      cancel: async () => effects.add('authoritative-cancel'),
    },
    {
      lockHeadForExpected: async () => ({ boardPk: '1' }),
      allocateSequenceAt: async () => 2,
      appendEvent: async () => undefined,
      eventIdAtSequence: async () => 'event_1',
    },
    { expireLocked: async () => stored.interaction },
    new HitlWaitCoordinator(),
    { writeSuccess: async () => undefined },
    () => new Date('2026-07-16T00:01:00.000Z'),
    () => 'event_2',
  );
  try {
    await service.cancel({
      principal: userPrincipal,
      boardId: 'board_1',
      hitlRequestId: 'hitl_1',
      request: {
        requestId: 'request_3',
        expectedRevisionId: 'revision_1',
        expectedStateUpdatedAt: replay
          ? stored.interaction.createdAt
          : stored.interaction.stateUpdatedAt,
      },
    });
  } catch {
    effects.add('authoritative-conflict');
  }
  return 'AUTHORITATIVE_STATE_ONLY';
};

const executeHitlBoundary = (row) =>
  Object.freeze({
    caseId: row.caseId,
    cluster: row.cluster,
    preconditionState: row.preconditionState,
    principalKind: row.principalKind,
  });

const executeHitlProductionBoundary = async (row, fixture) => {
  if (row.cluster === 'HITL_DESTRUCTIVE') return destructiveBoundary(row, fixture);
  const effects = new Set();
  const owner =
    row.cluster === 'HITL_LIVE_HISTORY'
      ? 'sceneboard.interaction-lifecycle-service'
      : row.cluster === 'SCENE_NONINTERACTIVE'
        ? 'sceneboard.interaction-command-service'
        : 'sceneboard.interaction-repository';
  const resource = { effects, repository: new InteractionRepository() };
  const handle = fixture.registerOwnerResource({
    owner,
    resource,
    cleanup: ({ effects: ownedEffects }) => ownedEffects.clear(),
    inspectResidue: () => effects.size,
  });
  return fixture.operate(
    handle,
    `hitl.${row.cluster.toLowerCase().replaceAll('_', '-')}`,
    async ({ repository }) => {
      if (row.cluster === 'HITL_STATE') {
        const [kind, terminalState] = row.preconditionState.toLowerCase().split('-');
        const result = await transitionWithRepository(repository, kind, terminalState);
        for (const effect of result.effects) effects.add(effect);
        return result.observed.toUpperCase();
      }
      if (row.cluster === 'HITL_RACE') {
        const contenders = Number.parseInt(row.preconditionState, 10);
        for (let repetition = 0; repetition < 20; repetition += 1) {
          const store = createCasConnection();
          const stored = storedInteraction();
          const outcomes = await Promise.allSettled(
            Array.from({ length: contenders }, () =>
              repository.answer(store.connection, {
                stored,
                context: contextFor(userPrincipal),
                requestId: 'request_2',
                response: responseFor('info'),
                sequence: 2,
                answeredAtSql: '2026-07-16 00:01:00.000',
              }),
            ),
          );
          if (outcomes.filter(({ status }) => status === 'fulfilled').length !== 1)
            return 'MULTIPLE_TERMINAL_WINNERS';
          store.effects.clear();
        }
        return 'ONE_TERMINAL_WINNER';
      }
      if (row.cluster === 'HITL_EXPIRY') {
        const expiresAt = Date.parse(storedInteraction().interaction.expiresAt);
        const now = row.preconditionState.startsWith('BEFORE')
          ? expiresAt - 1
          : row.preconditionState.startsWith('EQUAL')
            ? expiresAt
            : expiresAt + 1;
        const due = await repository.findDueCandidates(
          {
            execute: async () => [
              now >= expiresAt ? [{ boardId: 'board_1', hitlRequestId: 'hitl_1' }] : [],
            ],
          },
          new Date(now).toISOString().replace('T', ' ').replace('Z', ''),
          1,
        );
        effects.add(`expiry-due:${due.length}`);
        return due.length === 0 ? 'RESPONSE_ACCEPTABLE' : 'HITL_REQUEST_EXPIRED';
      }
      if (row.cluster === 'HITL_LIVE_HISTORY') return lifecycleBoundary(row, effects);
      if (row.cluster === 'SCENE_NONINTERACTIVE') {
        const command = commandServiceFor({
          stored: null,
          principal: userPrincipal,
          effects,
        });
        await command.service
          .apply({
            principal: userPrincipal,
            request: {
              protocolVersion: 1,
              requestId: 'request_noninteractive',
              idempotencyKey: 'noninteractive-idempotency',
              boardId: 'board_1',
              expectedRevisionId: 'revision_1',
              command: { type: row.preconditionState },
            },
          })
          .catch(() => undefined);
        return 'NO_HITL_RESPONSE_CONTROL';
      }
      throw new Error(`unsupported HITL boundary cluster: ${row.cluster}`);
    },
  );
};

await registerAuthenticatedBoundaryRows({
  producerId: 'sceneboard.security.hitl-race.v1',
  expectedCounts: {
    HITL_STATE: 20,
    HITL_RACE: 3,
    HITL_EXPIRY: 3,
    HITL_DESTRUCTIVE: 6,
    HITL_LIVE_HISTORY: 4,
    SCENE_NONINTERACTIVE: 2,
  },
  adapter: executeHitlBoundary,
  executeBoundary: executeHitlProductionBoundary,
});
