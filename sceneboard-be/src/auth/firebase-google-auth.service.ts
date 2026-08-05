import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';

import { AppError } from '../common/errors/app-error.js';
import { parseVerifiedEmail } from './auth.dto.js';

export interface VerifiedGoogleIdentity {
  email: string;
  emailNormalized: string;
}

export interface FirebaseIdTokenVerifierPort {
  verifyIdToken(idToken: string, checkRevoked: boolean): Promise<DecodedIdToken>;
}

export class FirebaseGoogleAuthService {
  private readonly verifier: FirebaseIdTokenVerifierPort | null;

  constructor(
    config: {
      enabled: boolean;
      projectId: string | null;
      clientEmail: string | null;
      privateKey: string | null;
    },
    verifier?: FirebaseIdTokenVerifierPort,
  ) {
    if (!config.enabled) {
      this.verifier = null;
      return;
    }
    if (verifier !== undefined) {
      this.verifier = verifier;
      return;
    }
    if (config.projectId === null || config.clientEmail === null || config.privateKey === null)
      throw new TypeError('enabled Firebase Google auth requires complete credentials');
    const appName = 'sceneboard-google-auth';
    const app: App = getApps().some((candidate) => candidate.name === appName)
      ? getApp(appName)
      : initializeApp(
          {
            credential: cert({
              projectId: config.projectId,
              clientEmail: config.clientEmail,
              privateKey: config.privateKey,
            }),
            projectId: config.projectId,
          },
          appName,
        );
    this.verifier = getAuth(app);
  }

  async verify(idToken: string): Promise<VerifiedGoogleIdentity> {
    if (this.verifier === null) throw new AppError('SERVICE_UNAVAILABLE');
    let decoded: DecodedIdToken;
    try {
      decoded = await this.verifier.verifyIdToken(idToken, true);
    } catch (cause) {
      throw new AppError('AUTH_INVALID_CREDENTIALS', { cause });
    }
    if (
      decoded.email_verified !== true ||
      typeof decoded.email !== 'string' ||
      decoded.firebase?.sign_in_provider !== 'google.com'
    )
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    try {
      return parseVerifiedEmail(decoded.email);
    } catch (cause) {
      throw new AppError('AUTH_INVALID_CREDENTIALS', { cause });
    }
  }
}
