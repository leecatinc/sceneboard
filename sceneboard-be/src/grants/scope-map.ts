import { type ClientGrantCapabilityV1 } from '@sceneboard/board-schema';

export const D2_SCOPE_CATALOG = [
  'board.read',
  'board.write',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'artifact.publish',
  'artifact.control',
  'board.media.write',
] as const satisfies readonly ClientGrantCapabilityV1[];

export const LIFECYCLE_PERMISSIONS = ['board.create', 'board.archive'] as const;
export type LifecyclePermission = (typeof LIFECYCLE_PERMISSIONS)[number];

const scopeBits: Readonly<Record<ClientGrantCapabilityV1, number>> = {
  'board.read': 1,
  'board.write': 2,
  'board.history.read': 4,
  'board.hitl.request': 8,
  'board.hitl.respond': 16,
  'artifact.publish': 32,
  'artifact.control': 64,
  'board.media.write': 128,
};

const lifecycleBits: Readonly<Record<LifecyclePermission, number>> = {
  'board.create': 1,
  'board.archive': 2,
};

const assertCatalogOrder = <Value extends string>(
  values: readonly Value[],
  catalog: readonly Value[],
): void => {
  let prior = -1;
  for (const value of values) {
    const index = catalog.indexOf(value);
    if (index < 0 || index <= prior)
      throw new TypeError('values must be a unique catalog-ordered subset');
    prior = index;
  }
};

export const scopeMaskFromValues = (values: readonly ClientGrantCapabilityV1[]): number => {
  assertCatalogOrder(values, D2_SCOPE_CATALOG);
  return values.reduce((mask, value) => mask | scopeBits[value], 0);
};

export const scopeValuesFromMask = (mask: number): ClientGrantCapabilityV1[] => {
  if (!Number.isInteger(mask) || mask < 0 || mask > 255)
    throw new TypeError('scope mask contains unknown bits');
  return D2_SCOPE_CATALOG.filter((value) => (mask & scopeBits[value]) !== 0);
};

export const lifecycleMaskFromValues = (values: readonly LifecyclePermission[]): number => {
  assertCatalogOrder(values, LIFECYCLE_PERMISSIONS);
  return values.reduce((mask, value) => mask | lifecycleBits[value], 0);
};

export const lifecycleValuesFromMask = (mask: number): LifecyclePermission[] => {
  if (!Number.isInteger(mask) || mask < 0 || mask > 3)
    throw new TypeError('lifecycle mask contains unknown bits');
  return LIFECYCLE_PERMISSIONS.filter((value) => (mask & lifecycleBits[value]) !== 0);
};
