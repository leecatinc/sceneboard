import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_DOCUMENT_LIMITS_V2,
  BOARD_EVENT_TYPES_V1,
  BOARD_LIMITS_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  BOARD_MUTATION_COMMAND_TYPES_V2,
  BOARD_OPERATION_TYPES_V1,
  BoardCapabilitiesParserV1,
  BoardCapabilitiesParserV2,
  HITL_KINDS_V1,
  NODE_TYPES_V1,
  PROTOCOL_SEMVER,
  type BoardCapabilities,
  type BoardCapabilitiesV1,
  type BoardCapabilitiesV2,
} from '@sceneboard/board-schema';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import type { AuthorizedBoardContextV1 } from './board-access.policy.js';

export function currentBoardCapabilitiesFromContext(
  context: Pick<AuthorizedBoardContextV1, 'actor' | 'artifactCapabilityPolicy'>,
): BoardCapabilitiesV1;
export function currentBoardCapabilitiesFromContext(
  context: Pick<AuthorizedBoardContextV1, 'actor' | 'artifactCapabilityPolicy'>,
  schemaVersion: 1,
): BoardCapabilitiesV1;
export function currentBoardCapabilitiesFromContext(
  context: Pick<AuthorizedBoardContextV1, 'actor' | 'artifactCapabilityPolicy'>,
  schemaVersion: 2,
): BoardCapabilitiesV2;
export function currentBoardCapabilitiesFromContext(
  context: Pick<AuthorizedBoardContextV1, 'actor' | 'artifactCapabilityPolicy'>,
  schemaVersion: 1 | 2 = 1,
): BoardCapabilities {
  const common = {
    protocolVersion: 1,
    type: 'board.capabilities',
    compatibilityMode: 'frozen-major',
    supported: {
      nodeTypes: [...NODE_TYPES_V1],
      operationTypes: [...BOARD_OPERATION_TYPES_V1],
      eventTypes: [...BOARD_EVENT_TYPES_V1],
      hitlKinds: [...HITL_KINDS_V1],
      artifactRequestCapabilities: [...ARTIFACT_REQUEST_CAPABILITIES_V1],
    },
    grantedCapabilities: [...context.actor.scopes],
    allowedArtifactRequestCapabilities: [
      ...context.artifactCapabilityPolicy.allowedArtifactRequestCapabilities,
    ],
  } as const;
  const parsed =
    schemaVersion === 1
      ? BoardCapabilitiesParserV1.parse({
          ...common,
          schemaVersion: PROTOCOL_SEMVER,
          supported: {
            ...common.supported,
            commandTypes: [...BOARD_MUTATION_COMMAND_TYPES_V1],
          },
          limits: { ...BOARD_LIMITS_V1 },
        })
      : BoardCapabilitiesParserV2.parse({
          ...common,
          schemaVersion: '1.1.0',
          supported: {
            ...common.supported,
            commandTypes: [...BOARD_MUTATION_COMMAND_TYPES_V2],
          },
          limits: { ...BOARD_DOCUMENT_LIMITS_V2 },
        });
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return parsed.data.value;
}
