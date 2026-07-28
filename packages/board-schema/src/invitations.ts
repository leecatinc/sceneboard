import { z } from 'zod';

import {
  BoardIdSchemaV1,
  GlobalIdStringSchemaV1,
  PrincipalIdSchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';

export const InvitationRoleSchemaV1 = z.enum(['editor', 'viewer']);
export const InvitationStateSchemaV1 = z.enum([
  'pending',
  'accepted',
  'revoked',
  'expired',
  'superseded',
]);

export const MemberCandidateSchemaV1 = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('account'),
      accountId: PrincipalIdSchemaV1,
      displayName: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('email'),
      email: z.string().email().max(254),
    })
    .strict(),
]);

export const MemberCandidateListSchemaV1 = z
  .object({
    candidates: z.array(MemberCandidateSchemaV1).max(20),
  })
  .strict();

export const BoardInvitationSchemaV1 = z
  .object({
    inviteId: GlobalIdStringSchemaV1,
    role: InvitationRoleSchemaV1,
    expiresAt: TimestampSchemaV1,
    state: InvitationStateSchemaV1,
  })
  .strict();

export const BoardInvitationEnvelopeSchemaV1 = z
  .object({
    invitation: BoardInvitationSchemaV1,
  })
  .strict();

export const InvitationMembershipSchemaV1 = z
  .object({
    boardId: BoardIdSchemaV1,
    accountId: PrincipalIdSchemaV1,
    role: InvitationRoleSchemaV1,
    version: z.number().int().safe().positive(),
  })
  .strict();

export const InvitationAcceptanceSchemaV1 = z
  .object({
    membership: InvitationMembershipSchemaV1,
    replayed: z.boolean(),
  })
  .strict();

export const ManagedMembershipSchemaV1 = z
  .object({
    accountId: PrincipalIdSchemaV1,
    role: InvitationRoleSchemaV1,
    version: z.number().int().safe().positive(),
  })
  .strict();

export const ManagedMembershipEnvelopeSchemaV1 = z
  .object({
    membership: ManagedMembershipSchemaV1,
    capabilityEpoch: z.number().int().safe().min(0),
  })
  .strict();

export type InvitationRoleV1 = z.infer<typeof InvitationRoleSchemaV1>;
export type InvitationStateV1 = z.infer<typeof InvitationStateSchemaV1>;
export type MemberCandidateV1 = z.infer<typeof MemberCandidateSchemaV1>;
export type MemberCandidateListV1 = z.infer<typeof MemberCandidateListSchemaV1>;
export type BoardInvitationV1 = z.infer<typeof BoardInvitationSchemaV1>;
export type BoardInvitationEnvelopeV1 = z.infer<typeof BoardInvitationEnvelopeSchemaV1>;
export type InvitationMembershipV1 = z.infer<typeof InvitationMembershipSchemaV1>;
export type InvitationAcceptanceV1 = z.infer<typeof InvitationAcceptanceSchemaV1>;
export type ManagedMembershipV1 = z.infer<typeof ManagedMembershipSchemaV1>;
export type ManagedMembershipEnvelopeV1 = z.infer<typeof ManagedMembershipEnvelopeSchemaV1>;
