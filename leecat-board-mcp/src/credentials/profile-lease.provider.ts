import type { ProfileLeaseAdapterV1, ProfileStateLeaseV1 } from './profile-state.lease.js';

export class ProfileLeaseProviderV1 {
  constructor(private readonly adapter: ProfileLeaseAdapterV1) {}

  verify(): Promise<boolean> {
    return this.adapter.verify();
  }

  acquire(stateDirectory: string): Promise<ProfileStateLeaseV1> {
    return this.adapter.acquire(stateDirectory);
  }
}
