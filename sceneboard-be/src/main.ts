import 'reflect-metadata';

import { pathToFileURL } from 'node:url';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { APP_ENVIRONMENT, type AppEnvironment } from './config/env.schema.js';
import { MigrationRunner } from './database/migrations/runner.js';
import { authorizeHttpMcpBootstrap } from './bootstrap/persistence-certification.bootstrap.js';
import { PersistenceCertificationService } from './bootstrap/persistence-certification.service.js';
import { requiresHeavyPersistenceCertification } from './bootstrap/bootstrap-policy.js';

export const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const environment = app.get<AppEnvironment>(APP_ENVIRONMENT);

  const state = await app.get(MigrationRunner).status();
  if (requiresHeavyPersistenceCertification(environment.appEnv)) {
    const authorized = await authorizeHttpMcpBootstrap(
      app.get(PersistenceCertificationService),
      state,
    );
    if (!authorized) throw new TypeError('persistence certification denied listener startup');
  }
  await app.listen(environment.port, '0.0.0.0');
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  bootstrap().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'BootstrapError';
    process.stderr.write(`SceneBoard API bootstrap failed: ${name}\n`);
    process.exitCode = 1;
  });
}
