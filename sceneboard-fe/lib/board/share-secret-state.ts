import type {
  SharePasswordResultV1,
  SharePublishResultV1,
  ShareRotateResultV1,
} from '../api/share-api';

export type ShareSecretActionV1 =
  | 'share.create'
  | 'share.republish'
  | 'share.rotate'
  | 'password.enable'
  | 'password.regenerate';

export type ShareSecretRequestV1 = {
  requestEpoch: number;
  action: ShareSecretActionV1;
  expectedShareId: string | null;
};

export type ShareSecretStateV1 =
  | { status: 'closed' }
  | { status: 'clearing' }
  | {
      status: 'showing';
      requestEpoch: number;
      shareId: string;
      linkToken: string | null;
      password: string | null;
    };

export type ShareSecretSettlementV1 =
  | { state: ShareSecretStateV1; recovery: null }
  | { state: ShareSecretStateV1; recovery: 'rotate_required' | 'regenerate_required' };

export const CLOSED_SHARE_SECRET_STATE_V1: ShareSecretStateV1 = { status: 'closed' };
export const CLEARING_SHARE_SECRET_STATE_V1: ShareSecretStateV1 = { status: 'clearing' };

export const beginShareSecretRequestV1 = (
  previousEpoch: number,
  action: ShareSecretActionV1,
  expectedShareId: string | null,
): { request: ShareSecretRequestV1; state: ShareSecretStateV1 } => ({
  request: { requestEpoch: previousEpoch + 1, action, expectedShareId },
  state: CLEARING_SHARE_SECRET_STATE_V1,
});

export const settleShareSecretRequestV1 = (
  current: ShareSecretRequestV1 | null,
  captured: ShareSecretRequestV1,
  result: SharePublishResultV1 | ShareRotateResultV1 | SharePasswordResultV1,
): ShareSecretSettlementV1 => {
  const closed = { state: CLOSED_SHARE_SECRET_STATE_V1, recovery: null } as const;
  if (
    current === null ||
    current.requestEpoch !== captured.requestEpoch ||
    current.action !== captured.action ||
    current.expectedShareId !== captured.expectedShareId
  ) {
    return closed;
  }
  if ('copySecretAvailable' in result) {
    return {
      state: CLOSED_SHARE_SECRET_STATE_V1,
      recovery:
        'rotateRequired' in result
          ? ('rotate_required' as const)
          : ('regenerate_required' as const),
    };
  }
  if (
    (captured.action === 'share.create' || captured.action === 'share.republish') &&
    (result.status === 'created' || result.status === 'republished') &&
    'linkToken' in result
  ) {
    return {
      state: {
        status: 'showing',
        requestEpoch: captured.requestEpoch,
        shareId: result.share.shareId,
        linkToken: result.linkToken,
        password: null,
      },
      recovery: null,
    };
  }
  if (
    captured.action === 'share.rotate' &&
    result.status === 'rotated' &&
    'linkToken' in result &&
    result.share.shareId === captured.expectedShareId
  ) {
    return {
      state: {
        status: 'showing',
        requestEpoch: captured.requestEpoch,
        shareId: result.share.shareId,
        linkToken: result.linkToken,
        password: null,
      },
      recovery: null,
    };
  }
  if (
    (captured.action === 'password.enable' || captured.action === 'password.regenerate') &&
    ((captured.action === 'password.enable' && result.status === 'enabled') ||
      (captured.action === 'password.regenerate' && result.status === 'regenerated')) &&
    'password' in result &&
    result.share.shareId === captured.expectedShareId
  ) {
    return {
      state: {
        status: 'showing',
        requestEpoch: captured.requestEpoch,
        shareId: result.share.shareId,
        linkToken: null,
        password: result.password,
      },
      recovery: null,
    };
  }
  return closed;
};
