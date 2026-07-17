export type ProfileLeaseFailureReasonV1 =
  | 'active_owner'
  | 'liveness_unknown'
  | 'lease_corrupt';

export class ProfileLeaseErrorV1 extends Error {
  constructor(readonly reason: ProfileLeaseFailureReasonV1) {
    super('Profile lease is unavailable');
    this.name = 'ProfileLeaseErrorV1';
  }
}

export type ProfileStateLeaseV1 = {
  release(): Promise<void>;
};

export interface ProfileLeaseAdapterV1 {
  acquire(stateDirectory: string): Promise<ProfileStateLeaseV1>;
  verify(): Promise<boolean>;
}
