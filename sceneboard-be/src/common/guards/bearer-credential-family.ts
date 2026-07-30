import { AppError } from '../errors/app-error.js';

export type BearerCredentialFamilyV1 = 'mcp_grant' | 'account_api_key';

export type SelectedBearerCredentialV1 = Readonly<{
  family: BearerCredentialFamilyV1;
  token: string;
}>;

const authorizationValues = (input: {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders?: readonly string[] | undefined;
}): readonly string[] => {
  if (input.rawHeaders !== undefined) {
    if (input.rawHeaders.length % 2 !== 0) throw new AppError('UNAUTHENTICATED');
    const values: string[] = [];
    for (let index = 0; index < input.rawHeaders.length; index += 2) {
      if (input.rawHeaders[index]?.toLowerCase() === 'authorization') {
        const value = input.rawHeaders[index + 1];
        if (value === undefined) throw new AppError('UNAUTHENTICATED');
        values.push(value);
      }
    }
    return values;
  }
  const value = input.headers.authorization;
  return typeof value === 'string' ? [value] : [];
};

export const selectBearerCredentialFamilyV1 = (input: {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders?: readonly string[] | undefined;
}): SelectedBearerCredentialV1 => {
  const values = authorizationValues(input);
  if (values.length !== 1) throw new AppError('UNAUTHENTICATED');
  const value = values[0]!;
  if (
    typeof input.headers.authorization !== 'string' ||
    input.headers.authorization !== value ||
    value.includes(',')
  ) {
    throw new AppError('UNAUTHENTICATED');
  }
  const match = /^Bearer ([^\s]+)$/iu.exec(value);
  const token = match?.[1];
  if (token === undefined) throw new AppError('UNAUTHENTICATED');
  if (token.startsWith('lcbg_v1.')) return Object.freeze({ family: 'mcp_grant', token });
  if (token.startsWith('sbk_v1.')) return Object.freeze({ family: 'account_api_key', token });
  throw new AppError('UNAUTHENTICATED');
};
