import { z } from 'zod';

import { CLIENT_GRANT_CAPABILITIES_V1 } from './catalogs.js';
import {
  GrantIdSchemaV1,
  PrincipalIdSchemaV1,
} from './identifiers.js';

const ClientGrantCapabilitySchemaV1 = z.enum(CLIENT_GRANT_CAPABILITIES_V1);

export const isSortedUniqueScopesV1 = (scopes: readonly string[]): boolean =>
  scopes.every((scope, index) => index === 0 || (scopes[index - 1] ?? '') < scope);

export const ActorContextSchemaV1 = z
  .object({
    principalKind: z.enum(['user', 'mcp_client', 'service']),
    principalId: PrincipalIdSchemaV1,
    grantId: GrantIdSchemaV1.nullable(),
    scopes: z.array(ClientGrantCapabilitySchemaV1).superRefine((scopes, context) => {
      if (!isSortedUniqueScopesV1(scopes)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'scopes must be sorted and unique' });
      }
    }),
  })
  .strict();

export const ActorReferenceSchemaV1 = z
  .object({
    principalKind: z.enum(['user', 'mcp_client', 'service']),
    principalId: PrincipalIdSchemaV1,
  })
  .strict();

export type ActorContextV1 = z.infer<typeof ActorContextSchemaV1>;
export type ActorReferenceV1 = z.infer<typeof ActorReferenceSchemaV1>;
