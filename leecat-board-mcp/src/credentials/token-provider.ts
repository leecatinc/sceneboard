import { ACCESS_TOKEN_PATTERN_V1, type CredentialRecordV1 } from './credential-record.js';
import { PrivateFileCredentialStoreV1 } from './private-file-credential.store.js';
import { ProfileLeaseProviderV1 } from './profile-lease.provider.js';

export type CredentialSnapshotV1 = CredentialRecordV1;

export interface TokenProviderV1 {
  snapshot(): Promise<CredentialSnapshotV1 | null>;
  invalidate(snapshot: CredentialSnapshotV1): Promise<void>;
}

export class EnvironmentTokenProviderV1 implements TokenProviderV1 {
  private invalidated = false;

  constructor(private readonly token: string | undefined) {
    if (token !== undefined && token !== '' && !ACCESS_TOKEN_PATTERN_V1.test(token)) {
      throw new Error('provisioned credential is invalid');
    }
  }

  async snapshot(): Promise<CredentialSnapshotV1 | null> {
    if (this.invalidated || this.token === undefined || this.token === '') return null;
    return { version: 1, generation: 'environment_v1_token', accessToken: this.token };
  }

  async invalidate(snapshot: CredentialSnapshotV1): Promise<void> {
    if (snapshot.generation === 'environment_v1_token' && snapshot.accessToken === this.token) this.invalidated = true;
  }
}

export class StoredTokenProviderV1 implements TokenProviderV1 {
  constructor(
    private readonly store: PrivateFileCredentialStoreV1,
    private readonly leases: ProfileLeaseProviderV1,
  ) {}

  async snapshot(): Promise<CredentialSnapshotV1 | null> {
    const lease = await this.leases.acquire(this.store.stateDirectory);
    try {
      return await this.store.read();
    } finally {
      await lease.release();
    }
  }

  async invalidate(snapshot: CredentialSnapshotV1): Promise<void> {
    const lease = await this.leases.acquire(this.store.stateDirectory);
    try {
      await this.store.deleteIfCurrent(snapshot);
    } finally {
      await lease.release();
    }
  }
}
