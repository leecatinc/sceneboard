import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_EVENT_TYPES_V1,
  BOARD_LIMITS_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  BOARD_OPERATION_TYPES_V1,
  BoardCapabilitiesParserV1,
  HITL_KINDS_V1,
  NODE_TYPES_V1,
  PROTOCOL_SEMVER,
  type BoardCapabilitiesV1,
} from '@sceneboard/board-schema';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import type { AuthorizedBoardContextV1 } from './board-access.policy.js';

export const currentBoardCapabilitiesFromContext = (
  context: Pick<AuthorizedBoardContextV1, 'actor' | 'artifactCapabilityPolicy'>,
): BoardCapabilitiesV1 => {
  const parsed = BoardCapabilitiesParserV1.parse({
    protocolVersion: 1,
    type: 'board.capabilities',
    schemaVersion: PROTOCOL_SEMVER,
    compatibilityMode: 'frozen-major',
    supported: {
      nodeTypes: [...NODE_TYPES_V1],
      commandTypes: [...BOARD_MUTATION_COMMAND_TYPES_V1],
      operationTypes: [...BOARD_OPERATION_TYPES_V1],
      eventTypes: [...BOARD_EVENT_TYPES_V1],
      hitlKinds: [...HITL_KINDS_V1],
      artifactRequestCapabilities: [...ARTIFACT_REQUEST_CAPABILITIES_V1],
    },
    limits: { ...BOARD_LIMITS_V1 },
    grantedCapabilities: [...context.actor.scopes],
    allowedArtifactRequestCapabilities: [
      ...context.artifactCapabilityPolicy.allowedArtifactRequestCapabilities,
    ],
  });
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return parsed.data.value;
};
