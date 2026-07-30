import type { AuditWriterPort } from '../auth/auth.persistence.js';

export interface AccountApiKeyAuditContext {
  correlationId: string;
  ownerPublicId: string | null;
  sessionPublicId: string | null;
  actorPublicId: string | null;
}

type AuditInput = Parameters<AuditWriterPort['writeMandatory']>[1];

const common = (
  context: AccountApiKeyAuditContext,
): Pick<
  AuditInput,
  'actorPublicId' | 'userPublicId' | 'sessionPublicId' | 'subjectFingerprint'
> => ({
  actorPublicId: context.actorPublicId,
  userPublicId: context.ownerPublicId,
  sessionPublicId: context.sessionPublicId,
  subjectFingerprint: null,
});

export const accountApiKeyIssuedAudit = (
  context: AccountApiKeyAuditContext,
  keyPublicId: string,
): AuditInput => ({
  event: 'api_key.issued',
  ...common(context),
  metadata: { keyPublicId, correlationId: context.correlationId },
});

export const accountApiKeyListedAudit = (
  context: AccountApiKeyAuditContext,
  resultCount: number,
): AuditInput => ({
  event: 'api_key.listed',
  ...common(context),
  metadata: { correlationId: context.correlationId, resultCount },
});

export const accountApiKeyRevokedAudit = (
  context: AccountApiKeyAuditContext,
  keyPublicId: string,
  reason: 'owner' | 'already_revoked' | 'not_found',
): AuditInput => ({
  event: 'api_key.revoked',
  ...common(context),
  metadata: { keyPublicId, correlationId: context.correlationId, reason },
});

export const accountApiKeyAuthenticationAudit = (
  context: AccountApiKeyAuditContext,
  input:
    | { succeeded: true; keyPublicId: string }
    | {
        succeeded: false;
        keyPublicId: string | null;
        reason: 'malformed' | 'unknown' | 'invalid' | 'expired' | 'revoked' | 'owner_disabled';
        subjectFingerprint: Buffer | null;
      },
): AuditInput => ({
  event: input.succeeded ? 'api_key.auth.succeeded' : 'api_key.auth.failed',
  ...common(context),
  actorPublicId: input.keyPublicId,
  subjectFingerprint: input.succeeded ? null : input.subjectFingerprint,
  metadata: {
    authMethod: 'account_api_key',
    ...(input.keyPublicId === null ? {} : { keyPublicId: input.keyPublicId }),
    correlationId: context.correlationId,
    ...(!input.succeeded ? { reason: input.reason } : {}),
  },
});
