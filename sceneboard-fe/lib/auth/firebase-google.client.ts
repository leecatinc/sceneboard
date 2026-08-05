'use client';

import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth';

const requiredPublicConfig = (key: string, value: string | undefined): string => {
  if (value === undefined || value.length === 0) throw new TypeError(`${key} is required`);
  return value;
};

export const obtainFirebaseGoogleIdToken = async (): Promise<string> => {
  const name = 'sceneboard-google-auth';
  const app = getApps().some((candidate) => candidate.name === name)
    ? getApp(name)
    : initializeApp(
        {
          apiKey: requiredPublicConfig(
            'NEXT_PUBLIC_FIREBASE_API_KEY',
            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
          ),
          authDomain: requiredPublicConfig(
            'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
            process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
          ),
          projectId: requiredPublicConfig(
            'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
            process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
          ),
          appId: requiredPublicConfig(
            'NEXT_PUBLIC_FIREBASE_APP_ID',
            process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
          ),
        },
        name,
      );
  const auth = getAuth(app);
  await setPersistence(auth, inMemoryPersistence);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const credential = await signInWithPopup(auth, provider);
  try {
    return await credential.user.getIdToken(true);
  } finally {
    await signOut(auth).catch(() => undefined);
  }
};
