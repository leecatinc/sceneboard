import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_SEMVER = '1.0.0' as const;

export const ProtocolVersionSchemaV1 = z.literal(PROTOCOL_VERSION);

export const isProtocolVersionV1 = (value: unknown): value is typeof PROTOCOL_VERSION =>
  value === PROTOCOL_VERSION;
