import { z } from 'zod';

import { BOARD_MEMBERSHIP_ROLES_V1, BOARD_MEMBERSHIP_STATES_V1 } from './catalogs.js';
import {
  BoardIdSchemaV1,
  GlobalIdStringSchemaV1,
  PrincipalIdSchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';

export const BoardMembershipSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('board.membership'),
    membershipId: GlobalIdStringSchemaV1,
    boardId: BoardIdSchemaV1,
    accountId: PrincipalIdSchemaV1,
    role: z.enum(BOARD_MEMBERSHIP_ROLES_V1),
    state: z.enum(BOARD_MEMBERSHIP_STATES_V1),
    version: z.number().int().safe().positive(),
    createdAt: TimestampSchemaV1,
    updatedAt: TimestampSchemaV1,
  })
  .strict()
  .superRefine((membership, context) => {
    if (membership.updatedAt < membership.createdAt)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'membership update must not predate creation',
      });
  });

export const BoardAuthorizationPrincipalSchemaV1 = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('account'),
      accountId: PrincipalIdSchemaV1,
    })
    .strict(),
  z
    .object({
      kind: z.literal('share_viewer'),
      shareId: GlobalIdStringSchemaV1,
    })
    .strict(),
]);

export type BoardMembershipV1 = z.infer<typeof BoardMembershipSchemaV1>;
export type BoardAuthorizationPrincipalV1 = z.infer<typeof BoardAuthorizationPrincipalSchemaV1>;
