import type { GrantSummary } from '../api/board-api';

export type HeaderConnectionState = 'idle' | 'connecting' | 'connected';
export const HEADER_GRANTS_CHANGED_EVENT = 'sceneboard:grants-changed';

export function deriveHeaderConnectionState(
  grants: ReadonlyArray<Pick<GrantSummary, 'status'>>,
): HeaderConnectionState {
  if (grants.some((grant) => grant.status === 'active')) return 'connected';
  if (grants.some((grant) => grant.status === 'pending_redemption')) return 'connecting';
  return 'idle';
}
