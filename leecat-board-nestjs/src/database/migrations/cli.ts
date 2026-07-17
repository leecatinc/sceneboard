import type { MigrationCertificationStateV1 } from './certification-state.js';

export type MigrationCliCallerV1 = 'db:migrate:status' | 'db:migrate:up' | 'db:migrate:adopt';

export type MigrationCliCommandV1 =
  | Readonly<{ command: 'status' }>
  | Readonly<{ command: 'up' }>
  | Readonly<{ command: 'adopt'; version: string; incidentRef: string }>;

export interface MigrationCliRunnerV1 {
  status(): Promise<MigrationCertificationStateV1>;
  up(): Promise<MigrationCertificationStateV1>;
  adopt(version: string): Promise<MigrationCertificationStateV1>;
}

export type MigrationCliCertificationOutcomeV1 = Readonly<{
  status: 'succeeded' | 'failed';
}>;

export type MigrationCliCertificationCallbackV1 = (
  caller: MigrationCliCallerV1,
  state: MigrationCertificationStateV1,
) => Promise<MigrationCliCertificationOutcomeV1>;

export type MigrationCliResultV1 =
  | Readonly<{ status: 'succeeded'; caller: MigrationCliCallerV1; exitCode: 0 }>
  | Readonly<{ status: 'failed'; code: 'MIGRATION_COMMAND_FAILED'; exitCode: 1 }>;

const isPrintableIncidentReference = (value: string): boolean => (
  value.length >= 1
  && value.length <= 200
  && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
);

export const parseMigrationCliArguments = (argv: readonly string[]): MigrationCliCommandV1 => {
  if (argv.length === 1 && argv[0] === 'status') return { command: 'status' };
  if (argv.length === 1 && argv[0] === 'up') return { command: 'up' };
  if (argv.length === 5
    && argv[0] === 'adopt'
    && argv[1] === '--version'
    && typeof argv[2] === 'string'
    && argv[2].length > 0
    && argv[3] === '--incident-ref'
    && typeof argv[4] === 'string'
    && isPrintableIncidentReference(argv[4])) {
    return { command: 'adopt', version: argv[2], incidentRef: argv[4] };
  }
  throw new TypeError('invalid migration command arguments');
};

export const runMigrationCli = async (
  argv: readonly string[],
  runner: MigrationCliRunnerV1,
  certify: MigrationCliCertificationCallbackV1,
): Promise<MigrationCliResultV1> => {
  try {
    const command = parseMigrationCliArguments(argv);
    const caller: MigrationCliCallerV1 = command.command === 'status'
      ? 'db:migrate:status'
      : command.command === 'up'
        ? 'db:migrate:up'
        : 'db:migrate:adopt';
    const state = command.command === 'status'
      ? await runner.status()
      : command.command === 'up'
        ? await runner.up()
        : await runner.adopt(command.version);
    const outcome = await certify(caller, state);
    if (outcome.status !== 'succeeded') {
      return { status: 'failed', code: 'MIGRATION_COMMAND_FAILED', exitCode: 1 };
    }
    return { status: 'succeeded', caller, exitCode: 0 };
  } catch {
    return { status: 'failed', code: 'MIGRATION_COMMAND_FAILED', exitCode: 1 };
  }
};
