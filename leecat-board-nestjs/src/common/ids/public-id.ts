import { GlobalIdStringParserV1 } from '@leecat-board/board-schema';

import { AppError } from '../errors/app-error.js';

declare const userIdBrand: unique symbol;
declare const sessionIdBrand: unique symbol;
declare const pairingIdBrand: unique symbol;
declare const clientIdBrand: unique symbol;
declare const grantIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: 'UserId' };
export type SessionId = string & { readonly [sessionIdBrand]: 'SessionId' };
export type PairingId = string & { readonly [pairingIdBrand]: 'PairingId' };
export type ClientId = string & { readonly [clientIdBrand]: 'ClientId' };
export type GrantId = string & { readonly [grantIdBrand]: 'GrantId' };

const parseGlobalId = <Value extends string>(value: unknown): Value => {
  const parsed = GlobalIdStringParserV1.parse(value);
  if (!parsed.ok) throw new AppError('INVALID_PAYLOAD');
  return parsed.data.value as Value;
};

export const parseUserId = (value: unknown): UserId => parseGlobalId<UserId>(value);
export const parseSessionId = (value: unknown): SessionId => parseGlobalId<SessionId>(value);
export const parsePairingId = (value: unknown): PairingId => parseGlobalId<PairingId>(value);
export const parseClientId = (value: unknown): ClientId => parseGlobalId<ClientId>(value);
export const parseGrantId = (value: unknown): GrantId => parseGlobalId<GrantId>(value);
