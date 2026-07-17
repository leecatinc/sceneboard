import type { AppEnvironmentName } from '../config/env.schema.js';

export const requiresHeavyPersistenceCertification = (appEnvironment: AppEnvironmentName): boolean => (
  appEnvironment === 'staging' || appEnvironment === 'production'
);
