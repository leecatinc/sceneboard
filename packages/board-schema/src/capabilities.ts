import { z } from 'zod';

import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_AUTHORIZATION_CAPABILITIES_V1,
  BOARD_EVENT_TYPES_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  BOARD_MUTATION_COMMAND_TYPES_V2,
  BOARD_OPERATION_TYPES_V1,
  CLIENT_GRANT_CAPABILITIES_V1,
  HITL_KINDS_V1,
  NODE_TYPES_V1,
} from './catalogs.js';
import { BOARD_DOCUMENT_LIMITS_V2, BOARD_LIMITS_V1 } from './limits.js';
import { PROTOCOL_SEMVER, PROTOCOL_VERSION } from './protocol-version.js';

const exactCatalog = <T extends readonly [string, ...string[]]>(catalog: T) =>
  z
    .array(z.enum(catalog))
    .length(catalog.length)
    .superRefine((values, context) => {
      if (values.some((value, index) => value !== catalog[index]))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'catalog order must match protocol',
        });
    });
const sortedSubset = <T extends readonly [string, ...string[]]>(catalog: T) =>
  z.array(z.enum(catalog)).superRefine((values, context) => {
    for (let index = 1; index < values.length; index += 1)
      if ((values[index - 1] ?? '') >= (values[index] ?? '')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'capabilities must be sorted and unique',
        });
        break;
      }
  });

export const BoardAuthorizationCapabilitySchemaV1 = z.enum(BOARD_AUTHORIZATION_CAPABILITIES_V1);

const ConnectionLifecyclePermissionSchemaV1 = z.enum(['board.archive', 'board.create']);

export const BoardSessionAccessSchemaV1 = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal('board.session.access'),
    capabilityEpoch: z.number().int().safe().min(0),
    authorizationCapabilities: sortedSubset(BOARD_AUTHORIZATION_CAPABILITIES_V1),
    connectionGrantCeiling: z
      .object({
        scopes: sortedSubset(CLIENT_GRANT_CAPABILITIES_V1),
        lifecyclePermissions: z
          .array(ConnectionLifecyclePermissionSchemaV1)
          .superRefine((values, context) => {
            for (let index = 1; index < values.length; index += 1)
              if ((values[index - 1] ?? '') >= (values[index] ?? '')) {
                context.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: 'lifecycle permissions must be sorted and unique',
                });
                break;
              }
          }),
      })
      .strict(),
  })
  .strict();

export type BoardSessionAccessV1 = z.infer<typeof BoardSessionAccessSchemaV1>;

const BoardLimitsSchemaV1 = z
  .object(
    Object.fromEntries(
      Object.entries(BOARD_LIMITS_V1).map(([key, value]) => [key, z.literal(value)]),
    ) as { [K in keyof typeof BOARD_LIMITS_V1]: z.ZodLiteral<(typeof BOARD_LIMITS_V1)[K]> },
  )
  .strict();

const BoardLimitsSchemaV2 = z
  .object(
    Object.fromEntries(
      Object.entries(BOARD_DOCUMENT_LIMITS_V2).map(([key, value]) => [key, z.literal(value)]),
    ) as {
      [K in keyof typeof BOARD_DOCUMENT_LIMITS_V2]: z.ZodLiteral<
        (typeof BOARD_DOCUMENT_LIMITS_V2)[K]
      >;
    },
  )
  .strict();

export const BoardCapabilitiesSchemaV1 = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal('board.capabilities'),
    schemaVersion: z.literal(PROTOCOL_SEMVER),
    compatibilityMode: z.literal('frozen-major'),
    supported: z
      .object({
        nodeTypes: exactCatalog(NODE_TYPES_V1),
        commandTypes: exactCatalog(BOARD_MUTATION_COMMAND_TYPES_V1),
        operationTypes: exactCatalog(BOARD_OPERATION_TYPES_V1),
        eventTypes: exactCatalog(BOARD_EVENT_TYPES_V1),
        hitlKinds: exactCatalog(HITL_KINDS_V1),
        artifactRequestCapabilities: exactCatalog(ARTIFACT_REQUEST_CAPABILITIES_V1),
      })
      .strict(),
    limits: BoardLimitsSchemaV1,
    grantedCapabilities: sortedSubset(CLIENT_GRANT_CAPABILITIES_V1),
    allowedArtifactRequestCapabilities: sortedSubset(ARTIFACT_REQUEST_CAPABILITIES_V1),
  })
  .strict();

export const DEFAULT_BOARD_CAPABILITIES_V1 = {
  protocolVersion: PROTOCOL_VERSION,
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
  grantedCapabilities: [],
  allowedArtifactRequestCapabilities: [],
} as const;

export type BoardCapabilitiesV1 = z.infer<typeof BoardCapabilitiesSchemaV1>;

export const BoardCapabilitiesSchemaV2 = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal('board.capabilities'),
    schemaVersion: z.literal('1.1.0'),
    compatibilityMode: z.literal('frozen-major'),
    supported: z
      .object({
        nodeTypes: exactCatalog(NODE_TYPES_V1),
        commandTypes: exactCatalog(BOARD_MUTATION_COMMAND_TYPES_V2),
        operationTypes: exactCatalog(BOARD_OPERATION_TYPES_V1),
        eventTypes: exactCatalog(BOARD_EVENT_TYPES_V1),
        hitlKinds: exactCatalog(HITL_KINDS_V1),
        artifactRequestCapabilities: exactCatalog(ARTIFACT_REQUEST_CAPABILITIES_V1),
      })
      .strict(),
    limits: BoardLimitsSchemaV2,
    grantedCapabilities: sortedSubset(CLIENT_GRANT_CAPABILITIES_V1),
    allowedArtifactRequestCapabilities: sortedSubset(ARTIFACT_REQUEST_CAPABILITIES_V1),
  })
  .strict();

export const DEFAULT_BOARD_CAPABILITIES_V2 = {
  protocolVersion: PROTOCOL_VERSION,
  type: 'board.capabilities',
  schemaVersion: '1.1.0',
  compatibilityMode: 'frozen-major',
  supported: {
    nodeTypes: [...NODE_TYPES_V1],
    commandTypes: [...BOARD_MUTATION_COMMAND_TYPES_V2],
    operationTypes: [...BOARD_OPERATION_TYPES_V1],
    eventTypes: [...BOARD_EVENT_TYPES_V1],
    hitlKinds: [...HITL_KINDS_V1],
    artifactRequestCapabilities: [...ARTIFACT_REQUEST_CAPABILITIES_V1],
  },
  limits: { ...BOARD_DOCUMENT_LIMITS_V2 },
  grantedCapabilities: [],
  allowedArtifactRequestCapabilities: [],
} as const;

export const BoardCapabilitiesSchemaV3 = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal('board.capabilities'),
    schemaVersion: z.literal('1.2.0'),
    compatibilityMode: z.literal('frozen-major'),
    supported: z
      .object({
        nodeTypes: exactCatalog(NODE_TYPES_V1),
        commandTypes: exactCatalog(BOARD_MUTATION_COMMAND_TYPES_V2),
        operationTypes: exactCatalog(BOARD_OPERATION_TYPES_V1),
        eventTypes: exactCatalog(BOARD_EVENT_TYPES_V1),
        hitlKinds: exactCatalog(HITL_KINDS_V1),
        artifactRequestCapabilities: exactCatalog(ARTIFACT_REQUEST_CAPABILITIES_V1),
      })
      .strict(),
    limits: BoardLimitsSchemaV2,
    grantedCapabilities: sortedSubset(CLIENT_GRANT_CAPABILITIES_V1),
    allowedArtifactRequestCapabilities: sortedSubset(ARTIFACT_REQUEST_CAPABILITIES_V1),
  })
  .strict();

export const DEFAULT_BOARD_CAPABILITIES_V3 = {
  ...DEFAULT_BOARD_CAPABILITIES_V2,
  schemaVersion: '1.2.0',
} as const;

export const BoardCapabilitiesSchema = z.union([
  BoardCapabilitiesSchemaV1,
  BoardCapabilitiesSchemaV2,
  BoardCapabilitiesSchemaV3,
]);

export type BoardCapabilitiesV2 = z.infer<typeof BoardCapabilitiesSchemaV2>;
export type BoardCapabilitiesV3 = z.infer<typeof BoardCapabilitiesSchemaV3>;
export type BoardCapabilities = z.infer<typeof BoardCapabilitiesSchema>;
