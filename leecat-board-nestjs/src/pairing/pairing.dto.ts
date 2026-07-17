import {
  BoardIdParserV1,
  type BoardId,
  type ClientGrantCapabilityV1,
} from '@leecat-board/board-schema';

import { AppError } from '../common/errors/app-error.js';
import { decodeBase64UrlStrict } from '../config/security.constants.js';
import {
  LIFECYCLE_PERMISSIONS,
  D2_SCOPE_CATALOG,
  lifecycleMaskFromValues,
  scopeMaskFromValues,
  type LifecyclePermission,
} from '../grants/scope-map.js';

export interface PairingClaimRequest {
  code: string;
  installationId: string;
  clientName: string;
  requestedScopes: ClientGrantCapabilityV1[];
  requestedLifecyclePermissions: LifecyclePermission[];
  clientProofChallenge: Buffer;
}

export type PairingDecisionRequest =
  | { decision: 'deny' }
  | {
    decision: 'approve';
    approvedScopes: ClientGrantCapabilityV1[];
    approvedLifecyclePermissions: LifecyclePermission[];
    boardIds: BoardId[];
    lifetime: 'session' | 'persistent';
  };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const parseScopes = (value: unknown, allowEmpty: boolean): ClientGrantCapabilityV1[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new AppError('INVALID_PAYLOAD');
  const result: ClientGrantCapabilityV1[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(D2_SCOPE_CATALOG as readonly string[]).includes(item)) {
      throw new AppError('INVALID_PAYLOAD');
    }
    result.push(item as ClientGrantCapabilityV1);
  }
  try {
    scopeMaskFromValues(result);
  } catch {
    throw new AppError('INVALID_PAYLOAD');
  }
  return result;
};

const parseLifecycle = (value: unknown): LifecyclePermission[] => {
  if (!Array.isArray(value)) throw new AppError('INVALID_PAYLOAD');
  const result: LifecyclePermission[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(LIFECYCLE_PERMISSIONS as readonly string[]).includes(item)) {
      throw new AppError('INVALID_PAYLOAD');
    }
    result.push(item as LifecyclePermission);
  }
  try {
    lifecycleMaskFromValues(result);
  } catch {
    throw new AppError('INVALID_PAYLOAD');
  }
  return result;
};

const parseClientName = (value: unknown): string => {
  if (typeof value !== 'string') throw new AppError('INVALID_PAYLOAD');
  const count = [...value].length;
  if (count < 1 || count > 100 || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return value;
};

export const parsePairingClaim = (value: unknown): PairingClaimRequest => {
  const keys = ['code', 'installationId', 'clientName', 'requestedScopes', 'requestedLifecyclePermissions', 'clientProofChallenge'];
  if (!isRecord(value) || !exactKeys(value, keys)) throw new AppError('INVALID_PAYLOAD');
  if (typeof value.code !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/i.test(value.code)) {
    throw new AppError('INVALID_PAYLOAD');
  }
  if (typeof value.installationId !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(value.installationId)) {
    throw new AppError('INVALID_PAYLOAD');
  }
  if (typeof value.clientProofChallenge !== 'string') throw new AppError('INVALID_PAYLOAD');
  let challenge: Buffer;
  try {
    challenge = decodeBase64UrlStrict(value.clientProofChallenge, { exactBytes: 32 });
  } catch {
    throw new AppError('INVALID_PAYLOAD');
  }
  return {
    code: value.code.toUpperCase(),
    installationId: value.installationId,
    clientName: parseClientName(value.clientName),
    requestedScopes: parseScopes(value.requestedScopes, false),
    requestedLifecyclePermissions: parseLifecycle(value.requestedLifecyclePermissions),
    clientProofChallenge: challenge,
  };
};

export const parsePairingDecision = (value: unknown): PairingDecisionRequest => {
  if (!isRecord(value) || typeof value.decision !== 'string') throw new AppError('INVALID_PAYLOAD');
  if (value.decision === 'deny') {
    if (!exactKeys(value, ['decision'])) throw new AppError('INVALID_PAYLOAD');
    return { decision: 'deny' };
  }
  const keys = ['decision', 'approvedScopes', 'approvedLifecyclePermissions', 'boardIds', 'lifetime'];
  if (value.decision !== 'approve' || !exactKeys(value, keys)) throw new AppError('INVALID_PAYLOAD');
  if (value.lifetime !== 'session' && value.lifetime !== 'persistent') throw new AppError('INVALID_PAYLOAD');
  if (!Array.isArray(value.boardIds) || value.boardIds.length < 1 || value.boardIds.length > 50) throw new AppError('INVALID_PAYLOAD');
  const boardIds: BoardId[] = [];
  for (const item of value.boardIds) {
    const parsed = BoardIdParserV1.parse(item);
    if (!parsed.ok) throw new AppError('INVALID_PAYLOAD');
    boardIds.push(parsed.data.value);
  }
  if (boardIds.some((boardId, index) => index > 0 && boardIds[index - 1]! >= boardId)) throw new AppError('PAIRING_SCOPE_INVALID');
  return {
    decision: 'approve',
    approvedScopes: parseScopes(value.approvedScopes, false),
    approvedLifecyclePermissions: parseLifecycle(value.approvedLifecyclePermissions),
    boardIds,
    lifetime: value.lifetime,
  };
};
