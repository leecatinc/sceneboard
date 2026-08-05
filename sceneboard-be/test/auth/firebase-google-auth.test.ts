import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecodedIdToken } from 'firebase-admin/auth';

import {
  FirebaseGoogleAuthService,
  type FirebaseIdTokenVerifierPort,
} from '../../src/auth/firebase-google-auth.service.js';
import { AppError } from '../../src/common/errors/app-error.js';

const enabled = {
  enabled: true,
  projectId: 'sceneboard-auth',
  clientEmail: 'firebase-adminsdk@sceneboard-auth.iam.gserviceaccount.com',
  privateKey: 'unused-by-injected-verifier',
};

test('Firebase verifier requires revoked-token checking, Google provider, and verified email', async () => {
  const calls: Array<{ token: string; revoked: boolean }> = [];
  const verifier: FirebaseIdTokenVerifierPort = {
    async verifyIdToken(token, revoked) {
      calls.push({ token, revoked });
      return {
        uid: 'firebase-user',
        aud: 'sceneboard-auth',
        auth_time: 1,
        exp: 2,
        firebase: { identities: {}, sign_in_provider: 'google.com' },
        iat: 1,
        iss: 'https://securetoken.google.com/sceneboard-auth',
        sub: 'firebase-user',
        email: 'User@Example.dev',
        email_verified: true,
      } as DecodedIdToken;
    },
  };
  const service = new FirebaseGoogleAuthService(enabled, verifier);
  assert.deepEqual(await service.verify('token'), {
    email: 'User@Example.dev',
    emailNormalized: 'user@example.dev',
  });
  assert.deepEqual(calls, [{ token: 'token', revoked: true }]);
});

test('Firebase verifier fails closed without configuration or valid Google identity evidence', async () => {
  const disabled = new FirebaseGoogleAuthService({
    enabled: false,
    projectId: null,
    clientEmail: null,
    privateKey: null,
  });
  await assert.rejects(
    () => disabled.verify('token'),
    (error) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
  );

  const invalid = new FirebaseGoogleAuthService(enabled, {
    async verifyIdToken() {
      return {
        firebase: { identities: {}, sign_in_provider: 'password' },
        email: 'User@Example.dev',
        email_verified: true,
      } as DecodedIdToken;
    },
  });
  await assert.rejects(
    () => invalid.verify('token'),
    (error) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
});
