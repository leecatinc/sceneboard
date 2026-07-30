import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

import { discoverBoardConfigV1 } from '../config/config-discovery.js';
import { resolveSecretReferenceV1 } from '../config/secret-reference.js';
import { ACCOUNT_API_KEY_PATTERN_V1 } from '../credentials/api-key-credential-record.js';
import { PrivateFileApiKeyStoreV1 } from '../credentials/private-file-api-key.store.js';

const MAX_SECRET_BYTES_V1 = 512;

export type ApiKeyCredentialCommandOptionsV1 = {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  readSecret?: () => Promise<string>;
};

export type ApiKeyCredentialCommandResultV1 =
  | { handled: false }
  | { handled: true; exitCode: 0 | 64 | 74 };

const safeWrite = (
  writer: ((value: string) => void) | undefined,
  value: Record<string, unknown>,
): void => {
  writer?.(`${JSON.stringify(value)}\n`);
};

const readBoundedStream = async (stream: NodeJS.ReadStream): Promise<string> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_SECRET_BYTES_V1) {
      for (const item of chunks) item.fill(0);
      bytes.fill(0);
      throw new Error('API key input is too large');
    }
    chunks.push(bytes);
  }
  const combined = Buffer.concat(chunks);
  for (const item of chunks) item.fill(0);
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(combined);
    return value.endsWith('\r\n')
      ? value.slice(0, -2)
      : value.endsWith('\n')
        ? value.slice(0, -1)
        : value;
  } finally {
    combined.fill(0);
  }
};

const readHiddenTtyLine = async (
  stdin: NodeJS.ReadStream,
  stderr: (value: string) => void,
): Promise<string> => {
  stderr('SceneBoard API key: ');
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({
    input: stdin,
    output: muted,
    terminal: true,
    historySize: 0,
  });
  try {
    const value = await readline.question('');
    stderr('\n');
    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES_V1)
      throw new Error('API key input is too large');
    return value;
  } finally {
    readline.close();
    muted.destroy();
  }
};

const commandArguments = (
  argv: readonly string[],
): { action: 'set' | 'remove'; configArgv: string[] } | null => {
  if (argv[0] !== 'api-key') return null;
  if (argv[1] !== 'set' && argv[1] !== 'remove') return null;
  const configArgv = argv.slice(2);
  if (configArgv.some((argument) => !argument.startsWith('--config=')) || configArgv.length > 1)
    return null;
  return { action: argv[1], configArgv };
};

export const runApiKeyCredentialCommandV1 = async (
  options: ApiKeyCredentialCommandOptionsV1,
): Promise<ApiKeyCredentialCommandResultV1> => {
  const command = commandArguments(options.argv);
  if (command === null) {
    if (options.argv[0] === 'api-key') {
      safeWrite(options.stderr, {
        ok: false,
        code: 'CLI_USAGE',
        message: 'Usage: sceneboard-mcp api-key set|remove [--config=/absolute/path]',
      });
      return { handled: true, exitCode: 64 };
    }
    return { handled: false };
  }
  try {
    const loaded = await discoverBoardConfigV1({
      argv: command.configArgv,
      cwd: options.cwd,
      env: options.env,
    });
    if ((loaded.config.credentialMode ?? 'pairing') !== 'api_key')
      throw new Error('API key credential mode is not configured');
    const reference = resolveSecretReferenceV1(loaded.config, options.env);
    if (reference.kind !== 'store')
      throw new Error('API key command requires a private-store reference');
    const store = new PrivateFileApiKeyStoreV1(reference.stateDirectory);
    if (command.action === 'remove') {
      const removed = await store.delete();
      safeWrite(options.stdout, {
        ok: true,
        action: 'remove',
        removed,
        profile: reference.profile,
      });
      return { handled: true, exitCode: 0 };
    }
    const stdin = options.stdin ?? process.stdin;
    const secret =
      options.readSecret !== undefined
        ? await options.readSecret()
        : stdin.isTTY
          ? await readHiddenTtyLine(
              stdin,
              options.stderr ?? ((value) => process.stderr.write(value)),
            )
          : await readBoundedStream(stdin);
    if (!ACCOUNT_API_KEY_PATTERN_V1.test(secret)) throw new Error('API key credential is invalid');
    await store.replace(secret);
    safeWrite(options.stdout, {
      ok: true,
      action: 'set',
      profile: reference.profile,
    });
    return { handled: true, exitCode: 0 };
  } catch {
    safeWrite(options.stderr, {
      ok: false,
      code: 'API_KEY_CREDENTIAL_COMMAND_FAILED',
      message: 'API key credential command failed',
    });
    return { handled: true, exitCode: 74 };
  }
};
