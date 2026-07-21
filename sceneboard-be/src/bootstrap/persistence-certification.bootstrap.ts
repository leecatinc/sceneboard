import { pathToFileURL } from 'node:url';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import type { MigrationCertificationStateV1 } from '../database/migrations/certification-state.js';
import { MigrationRunner } from '../database/migrations/runner.js';
import { runMigrationCli, type MigrationCliResultV1 } from '../database/migrations/cli.js';
import type {
  MigrationCliCallerV1,
  MigrationCliCertificationCallbackV1,
} from '../database/migrations/cli.js';
import { PersistenceCertificationService } from './persistence-certification.service.js';
import type {
  CertificationCallerV1,
  CertificationDispatchV1,
  PersistenceCertificationResultV1,
  PersistenceCertificationServiceV1,
} from './persistence-certification.types.js';

const assertNever = (value: never): never => {
  throw new TypeError(`unsupported persistence certification dispatch: ${String(value)}`);
};

export const buildCertificationDispatch = (
  caller: CertificationCallerV1,
  state: MigrationCertificationStateV1,
): CertificationDispatchV1 => {
  const stateFields = {
    stateMode: state.mode,
    registryVersion: state.registryVersion,
    connectionProfile: state.connectionProfile,
  };
  switch (caller) {
    case 'db:migrate:up':
      if (state.mode !== 'fresh' && state.mode !== 'restart') {
        throw new TypeError('migration up certification requires fresh or restart state');
      }
      return {
        ...stateFields,
        stateMode: state.mode,
        caller,
        certificationMode: 'FULL_OFFLINE',
        successAction: 'CLI_EXIT_0_LISTENERS_STOPPED',
        authorizesListener: false,
      };
    case 'db:migrate:adopt':
      if (state.mode !== 'adopt')
        throw new TypeError('migration adoption certification requires adopt state');
      return {
        ...stateFields,
        stateMode: state.mode,
        caller,
        certificationMode: 'FULL_OFFLINE',
        successAction: 'CLI_EXIT_0_LISTENERS_STOPPED',
        authorizesListener: false,
      };
    case 'quarantine.restore.promote':
      if (state.mode !== 'restart')
        throw new TypeError('restore promotion certification requires restart state');
      return {
        ...stateFields,
        stateMode: state.mode,
        caller,
        certificationMode: 'FULL_OFFLINE',
        successAction: 'WRITE_PROMOTION_EVIDENCE_LISTENERS_STOPPED',
        authorizesListener: false,
      };
    case 'db:migrate:status':
      if (state.mode !== 'restart')
        throw new TypeError('migration status certification requires restart state');
      return {
        ...stateFields,
        stateMode: state.mode,
        caller,
        certificationMode: 'BOUNDED_RESTART',
        successAction: 'CLI_EXIT_0_BOUNDED_REPORT_ONLY',
        authorizesListener: false,
      };
    case 'http-mcp.bootstrap':
      if (state.mode !== 'restart')
        throw new TypeError('application bootstrap certification requires restart state');
      return {
        ...stateFields,
        stateMode: state.mode,
        caller,
        certificationMode: 'BOUNDED_RESTART',
        successAction: 'START_LISTENER',
        authorizesListener: true,
      };
    case 'db:persistence:scan':
      if (state.mode !== 'restart')
        throw new TypeError('persistence scan certification requires restart state');
      return {
        ...stateFields,
        stateMode: state.mode,
        caller,
        certificationMode: 'RESUMABLE_AUDIT',
        successAction: 'CLI_EXIT_0_OPERATOR_EVIDENCE_ONLY',
        authorizesListener: false,
      };
  }
  return assertNever(caller);
};

const isCorrelatedResult = (
  result: PersistenceCertificationResultV1,
  dispatch: CertificationDispatchV1,
): boolean =>
  result.caller === dispatch.caller &&
  result.certificationMode === dispatch.certificationMode &&
  result.stateMode === dispatch.stateMode &&
  result.registryVersion === dispatch.registryVersion &&
  result.authorizesListener === (result.status === 'succeeded' && dispatch.authorizesListener) &&
  (result.status === 'failed' ||
    (result.successAction === dispatch.successAction &&
      result.connectionProfile.databaseIdentitySha256 ===
        dispatch.connectionProfile.databaseIdentitySha256 &&
      result.connectionProfile.serverVersion === dispatch.connectionProfile.serverVersion &&
      result.connectionProfile.timeZone === dispatch.connectionProfile.timeZone &&
      result.connectionProfile.characterSet === dispatch.connectionProfile.characterSet &&
      result.connectionProfile.collation === dispatch.connectionProfile.collation &&
      result.connectionProfile.sqlModeSha256 === dispatch.connectionProfile.sqlModeSha256));

export const certifyPersistenceForCaller = async (
  service: PersistenceCertificationServiceV1,
  caller: CertificationCallerV1,
  state: MigrationCertificationStateV1,
): Promise<PersistenceCertificationResultV1> => {
  const dispatch = buildCertificationDispatch(caller, state);
  const result = await service.certify(dispatch);
  if (!isCorrelatedResult(result, dispatch)) {
    return {
      status: 'failed',
      code: 'PERSISTENCE_CERTIFICATION_FAILED',
      category: 'STATE_OR_PROFILE',
      caller: dispatch.caller,
      certificationMode: dispatch.certificationMode,
      stateMode: dispatch.stateMode,
      registryVersion: dispatch.registryVersion,
      retryable: false,
      authorizesListener: false,
    };
  }
  return result;
};

export const createMigrationCertificationCallback =
  (service: PersistenceCertificationServiceV1): MigrationCliCertificationCallbackV1 =>
  async (caller: MigrationCliCallerV1, state: MigrationCertificationStateV1) => {
    const result = await certifyPersistenceForCaller(service, caller, state);
    return { status: result.status };
  };

export const authorizeHttpMcpBootstrap = async (
  service: PersistenceCertificationServiceV1,
  state: MigrationCertificationStateV1,
): Promise<boolean> => {
  const result = await certifyPersistenceForCaller(service, 'http-mcp.bootstrap', state);
  return (
    result.status === 'succeeded' &&
    result.caller === 'http-mcp.bootstrap' &&
    result.certificationMode === 'BOUNDED_RESTART' &&
    result.successAction === 'START_LISTENER' &&
    result.authorizesListener
  );
};

export const runMigrationCertificationProcess = async (
  argv: readonly string[],
): Promise<MigrationCliResultV1> => {
  if (argv[0] !== 'migration') {
    return { status: 'failed', code: 'MIGRATION_COMMAND_FAILED', exitCode: 1 };
  }
  const context = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    return await runMigrationCli(
      argv.slice(1),
      context.get(MigrationRunner),
      createMigrationCertificationCallback(context.get(PersistenceCertificationService)),
    );
  } finally {
    await context.close();
  }
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runMigrationCertificationProcess(process.argv.slice(2))
    .then((result) => {
      process.exitCode = result.exitCode;
      const destination = result.status === 'succeeded' ? process.stdout : process.stderr;
      destination.write(
        result.status === 'succeeded'
          ? `SceneBoard persistence certification succeeded: ${result.caller}\n`
          : 'SceneBoard persistence certification failed: MIGRATION_COMMAND_FAILED\n',
      );
    })
    .catch(() => {
      process.exitCode = 1;
      process.stderr.write(
        'SceneBoard persistence certification failed: MIGRATION_COMMAND_FAILED\n',
      );
    });
}
