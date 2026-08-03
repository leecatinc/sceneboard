import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { basename, isAbsolute, normalize, posix, resolve } from 'node:path';

export const LOCAL_EXPORT_MAX_BYTES_V1 = 536_870_912;
const LOCAL_EXPORT_MAX_STDERR_BYTES_V1 = 4_096;
const LOCAL_EXPORT_MAX_STDOUT_BYTES_V1 = 128;
const LINUX_O_DIRECTORY = 0x1_0000;
const LINUX_O_CLOEXEC = 0x8_0000;

export type LocalExportFormatV1 = 'pdf' | 'pptx';

export type LocalExportErrorCodeV1 =
  | 'LOCAL_EXPORT_UNAVAILABLE'
  | 'LOCAL_EXPORT_INVALID_PATH'
  | 'LOCAL_EXPORT_EXISTS'
  | 'LOCAL_EXPORT_IO'
  | 'LOCAL_EXPORT_SHORT'
  | 'LOCAL_EXPORT_CORRUPT'
  | 'LOCAL_EXPORT_CANCELLED';

export type LocalExportErrorV1 = Readonly<{
  code: LocalExportErrorCodeV1;
  message: string;
  retryable: false;
  details: null;
}>;

export type LocalExportPreparedIntentV1 = Readonly<{
  format: LocalExportFormatV1;
  components: readonly string[];
  normalizedPathBytes: number;
  displayName: string;
  helperHandle: { descriptor: number; released: boolean };
}>;

export type LocalExportArtifactV1 = Readonly<{
  format: LocalExportFormatV1;
  contentType: string;
  contentLength: number;
  body: ReadableStream<Uint8Array>;
}>;

export type LocalExportPublishResultV1 =
  | Readonly<{
      ok: true;
      value: { format: LocalExportFormatV1; bytes: number; fileName: string };
    }>
  | Readonly<{
      ok: false;
      error:
        | LocalExportErrorV1
        | Readonly<{
            code: 'BOARD_MCP_TRANSPORT_ERROR';
            message: 'SceneBoard transport is unavailable';
            retryable: true;
            details: { phase: 'response' };
          }>;
    }>;

type LocalExportManifestV1 = Readonly<{
  version: 1;
  targets: Readonly<{
    'linux-x64-gnu': Readonly<{
      path: 'linux-x64-gnu/local-export-helper';
      sha256: string;
      mode: '0500';
    }>;
  }>;
}>;

export type LocalExportFileOptionsV1 = Readonly<{
  manifestPath: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  glibc?: boolean;
  spawn?: typeof spawn;
  effectiveUserId?: number;
}>;

const error = (code: LocalExportErrorCodeV1): LocalExportErrorV1 => {
  const messages: Readonly<Record<LocalExportErrorCodeV1, string>> = {
    LOCAL_EXPORT_UNAVAILABLE: 'Secure local export is unavailable on this platform',
    LOCAL_EXPORT_INVALID_PATH: 'Local export path is invalid',
    LOCAL_EXPORT_EXISTS: 'Local export target already exists',
    LOCAL_EXPORT_IO: 'Local export could not be published',
    LOCAL_EXPORT_SHORT: 'Export download ended before completion',
    LOCAL_EXPORT_CORRUPT: 'Export download or local helper response is invalid',
    LOCAL_EXPORT_CANCELLED: 'Local export was cancelled',
  };
  return Object.freeze({ code, message: messages[code], retryable: false, details: null });
};

const transportErrorV1 = () =>
  Object.freeze({
    code: 'BOARD_MCP_TRANSPORT_ERROR' as const,
    message: 'SceneBoard transport is unavailable' as const,
    retryable: true as const,
    details: Object.freeze({ phase: 'response' as const }),
  });

const detectGlibcV1 = (): boolean => {
  try {
    const report = process.report?.getReport();
    const header =
      report !== undefined && typeof report === 'object'
        ? (report as { header?: { glibcVersionRuntime?: unknown } }).header
        : undefined;
    return header !== undefined && typeof header.glibcVersionRuntime === 'string';
  } catch {
    return false;
  }
};

const exactManifestV1 = (value: unknown): LocalExportManifestV1 | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join('\0') !== ['targets', 'version'].join('\0')) return null;
  if (root.version !== 1 || root.targets === null || typeof root.targets !== 'object') return null;
  const targets = root.targets as Record<string, unknown>;
  if (Object.keys(targets).join('\0') !== 'linux-x64-gnu') return null;
  const target = targets['linux-x64-gnu'];
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return null;
  const entry = target as Record<string, unknown>;
  if (Object.keys(entry).sort().join('\0') !== ['mode', 'path', 'sha256'].join('\0')) return null;
  if (
    entry.path !== 'linux-x64-gnu/local-export-helper' ||
    entry.mode !== '0500' ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    return null;
  return value as LocalExportManifestV1;
};

const safeDisplayNameV1 = (path: string): string => {
  const safe = basename(path)
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 120);
  return safe === '' ? 'sceneboard-export' : safe;
};

const parseAbsolutePathV1 = (
  outputFile: string,
  format: LocalExportFormatV1,
): Omit<LocalExportPreparedIntentV1, 'helperHandle'> | null => {
  if (
    outputFile.length === 0 ||
    outputFile !== outputFile.normalize('NFC') ||
    !isAbsolute(outputFile) ||
    !outputFile.startsWith('/') ||
    normalize(outputFile) !== outputFile ||
    outputFile.endsWith('/') ||
    /[*?[\]{}!]/u.test(outputFile)
  )
    return null;
  const components = outputFile.slice(1).split('/');
  if (
    components.length === 0 ||
    components.length > 64 ||
    components.some((component) => {
      const bytes = Buffer.byteLength(component, 'utf8');
      return (
        component === '' ||
        component === '.' ||
        component === '..' ||
        component !== component.normalize('NFC') ||
        component.includes('\0') ||
        bytes === 0 ||
        bytes > 255
      );
    })
  )
    return null;
  const normalizedPathBytes = Buffer.byteLength(outputFile, 'utf8');
  const expectedExtension = format === 'pdf' ? '.pdf' : '.pptx';
  if (
    normalizedPathBytes > 4_096 ||
    !components.at(-1)?.endsWith(expectedExtension) ||
    components.at(-1) === expectedExtension
  )
    return null;
  return Object.freeze({
    format,
    components: Object.freeze(components),
    normalizedPathBytes,
    displayName: safeDisplayNameV1(outputFile),
  });
};

const writeU64BeV1 = (buffer: Buffer, offset: number, value: number): void => {
  const big = BigInt(value);
  buffer.writeUInt32BE(Number((big >> 32n) & 0xffff_ffffn), offset);
  buffer.writeUInt32BE(Number(big & 0xffff_ffffn), offset + 4);
};

export const encodeLocalExportControlFrameV1 = (
  intent: Pick<LocalExportPreparedIntentV1, 'format' | 'components' | 'normalizedPathBytes'>,
  expectedBytes: number,
): Buffer => {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > LOCAL_EXPORT_MAX_BYTES_V1
  )
    throw new TypeError('invalid local export byte count');
  const encoded = intent.components.map((component) => Buffer.from(component, 'utf8'));
  const frameBytes = 24 + encoded.reduce((total, component) => total + 2 + component.byteLength, 0);
  if (frameBytes > 65_532) throw new TypeError('local export control frame is too large');
  const frame = Buffer.allocUnsafe(4 + frameBytes);
  frame.writeUInt32BE(frameBytes, 0);
  frame.write('SBEX', 4, 4, 'ascii');
  frame.writeUInt16BE(1, 8);
  frame.writeUInt16BE(0, 10);
  frame.writeUInt8(intent.format === 'pdf' ? 1 : 2, 12);
  frame.writeUInt8(encoded.length, 13);
  frame.writeUInt16BE(0, 14);
  writeU64BeV1(frame, 16, expectedBytes);
  frame.writeUInt32BE(intent.normalizedPathBytes, 24);
  let cursor = 28;
  for (const component of encoded) {
    frame.writeUInt16BE(component.byteLength, cursor);
    cursor += 2;
    component.copy(frame, cursor);
    cursor += component.byteLength;
  }
  return frame;
};

const signatureMatchesV1 = (format: LocalExportFormatV1, bytes: Buffer): boolean =>
  format === 'pdf'
    ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))
    : bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

const writeWithBackpressureV1 = async (
  child: ChildProcessWithoutNullStreams,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted();
  if (child.stdin.write(bytes)) return;
  await new Promise<void>((resolveDrain, reject) => {
    const cleanup = (): void => {
      child.stdin.off('drain', drained);
      child.stdin.off('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const drained = (): void => {
      cleanup();
      resolveDrain();
    };
    const failed = (streamError: Error): void => {
      cleanup();
      reject(streamError);
    };
    const aborted = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    child.stdin.once('drain', drained);
    child.stdin.once('error', failed);
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
};

const collectBoundedV1 = (
  child: ChildProcessWithoutNullStreams,
  stream: NodeJS.ReadableStream,
  limit: number,
  onOverflow: () => void,
  signal?: AbortSignal,
): Promise<Buffer> =>
  new Promise((resolveBytes, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      stream.off('data', received);
      stream.off('error', failed);
      stream.off('end', ended);
      child.off('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const failed = (streamError: Error): void => {
      cleanup();
      reject(streamError);
    };
    const ended = (): void => {
      cleanup();
      resolveBytes(Buffer.concat(chunks, size));
    };
    const aborted = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    const received = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > limit) {
        cleanup();
        onOverflow();
        reject(new Error('local export helper output overflow'));
        return;
      }
      chunks.push(bytes);
    };
    stream.on('data', received);
    stream.once('error', failed);
    stream.once('end', ended);
    child.once('error', failed);
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });

const waitForExitV1 = (
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolveExit, reject) => {
    const cleanup = (): void => {
      child.off('error', failed);
      child.off('exit', exited);
      signal?.removeEventListener('abort', aborted);
    };
    const failed = (childError: Error): void => {
      cleanup();
      reject(childError);
    };
    const exited = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      cleanup();
      resolveExit({ code, signal: exitSignal });
    };
    const aborted = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    child.once('error', failed);
    child.once('exit', exited);
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });

const endWritableV1 = (
  stream: NodeJS.WritableStream,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolveEnd, reject) => {
    const cleanup = (): void => {
      stream.removeListener('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const failed = (streamError: Error): void => {
      cleanup();
      reject(streamError);
    };
    const ended = (): void => {
      cleanup();
      resolveEnd();
    };
    const aborted = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    stream.once('error', failed);
    if (signal?.aborted) aborted();
    else {
      signal?.addEventListener('abort', aborted, { once: true });
      stream.end(bytes, ended);
    }
  });

const readWithSignalV1 = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  signal?.throwIfAborted();
  return new Promise((resolveRead, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', aborted);
    const aborted = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    reader.read().then(
      (value) => {
        cleanup();
        if (signal?.aborted) reject(signal.reason);
        else resolveRead(value);
      },
      (readError: unknown) => {
        cleanup();
        reject(readError);
      },
    );
    signal?.addEventListener('abort', aborted, { once: true });
  });
};

const cancelReaderBestEffortV1 = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  void reader.cancel().catch(() => undefined);
};

const destroyStreamV1 = (stream: NodeJS.ReadableStream | NodeJS.WritableStream | null): void => {
  if (stream !== null && 'destroy' in stream && typeof stream.destroy === 'function')
    stream.destroy();
};

const waitForChildExitBoundedV1 = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('exit', exited);
      child.off('error', exited);
    };
    const exited = (): void => {
      cleanup();
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolveExit(false);
    }, timeoutMs);
    child.once('exit', exited);
    child.once('error', exited);
  });
};

const waitForReadableClosureBoundedV1 = async (
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<boolean> => {
  const readable = stream as NodeJS.ReadableStream & {
    destroyed?: boolean;
    readableEnded?: boolean;
  };
  if (readable.destroyed === true || readable.readableEnded === true) return true;
  return new Promise<boolean>((resolveClosure) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener('close', closed);
      stream.removeListener('end', closed);
      stream.removeListener('error', closed);
    };
    const closed = (): void => {
      cleanup();
      resolveClosure(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolveClosure(false);
    }, timeoutMs);
    stream.once('close', closed);
    stream.once('end', closed);
    stream.once('error', closed);
  });
};

const terminateChildV1 = async (
  child: ChildProcessWithoutNullStreams,
  control: NodeJS.WritableStream | undefined,
  publicationMayExist: boolean,
): Promise<void> => {
  destroyStreamV1(control ?? null);
  destroyStreamV1(child.stdin);
  if (!publicationMayExist) {
    destroyStreamV1(child.stdout);
    destroyStreamV1(child.stderr);
  }
  const waitForPublicationClosure = async (): Promise<void> => {
    if (!publicationMayExist) return;
    await Promise.all([
      waitForReadableClosureBoundedV1(child.stdout, 750),
      waitForReadableClosureBoundedV1(child.stderr, 750),
    ]);
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    await waitForPublicationClosure();
    return;
  }
  child.kill('SIGTERM');
  if (await waitForChildExitBoundedV1(child, 250)) {
    await waitForPublicationClosure();
    return;
  }
  child.kill('SIGKILL');
  await Promise.all([waitForChildExitBoundedV1(child, 250), waitForPublicationClosure()]);
};

export class LocalExportFileV1 {
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly glibc: boolean;
  private readonly spawnProcess: typeof spawn;
  private readonly effectiveUserId: number | undefined;

  constructor(private readonly options: LocalExportFileOptionsV1) {
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.glibc = options.glibc ?? detectGlibcV1();
    this.spawnProcess = options.spawn ?? spawn;
    this.effectiveUserId = options.effectiveUserId ?? process.geteuid?.();
  }

  preflight(
    outputFile: string,
    format: LocalExportFormatV1,
  ):
    | Readonly<{ ok: true; value: LocalExportPreparedIntentV1 }>
    | Readonly<{ ok: false; error: LocalExportErrorV1 }> {
    if (this.platform !== 'linux' || this.architecture !== 'x64' || !this.glibc)
      return { ok: false, error: error('LOCAL_EXPORT_UNAVAILABLE') };
    const parsedPath = parseAbsolutePathV1(outputFile, format);
    if (parsedPath === null) return { ok: false, error: error('LOCAL_EXPORT_INVALID_PATH') };
    let descriptor = -1;
    let manifestDescriptor = -1;
    try {
      const manifestPathStatus = lstatSync(this.options.manifestPath);
      if (
        !manifestPathStatus.isFile() ||
        manifestPathStatus.isSymbolicLink() ||
        (manifestPathStatus.mode & 0o777) !== 0o400 ||
        manifestPathStatus.uid !== this.effectiveUserId
      )
        return { ok: false, error: error('LOCAL_EXPORT_UNAVAILABLE') };
      manifestDescriptor = openSync(
        this.options.manifestPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | LINUX_O_CLOEXEC,
      );
      const manifestStatus = fstatSync(manifestDescriptor);
      if (
        !manifestStatus.isFile() ||
        manifestStatus.dev !== manifestPathStatus.dev ||
        manifestStatus.ino !== manifestPathStatus.ino ||
        (manifestStatus.mode & 0o777) !== 0o400 ||
        manifestStatus.uid !== this.effectiveUserId
      ) {
        closeSync(manifestDescriptor);
        manifestDescriptor = -1;
        return { ok: false, error: error('LOCAL_EXPORT_UNAVAILABLE') };
      }
      const manifest = exactManifestV1(JSON.parse(readFileSync(manifestDescriptor, 'utf8')));
      closeSync(manifestDescriptor);
      manifestDescriptor = -1;
      if (manifest === null) return { ok: false, error: error('LOCAL_EXPORT_UNAVAILABLE') };
      const helperPath = resolve(
        posix.dirname(this.options.manifestPath),
        manifest.targets['linux-x64-gnu'].path,
      );
      const pathStatus = lstatSync(helperPath);
      if (
        !pathStatus.isFile() ||
        pathStatus.isSymbolicLink() ||
        (pathStatus.mode & 0o777) !== 0o500 ||
        pathStatus.uid !== this.effectiveUserId
      )
        return { ok: false, error: error('LOCAL_EXPORT_UNAVAILABLE') };
      descriptor = openSync(
        helperPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | LINUX_O_CLOEXEC,
      );
      const helperStatus = fstatSync(descriptor);
      const digest = createHash('sha256').update(readFileSync(descriptor)).digest('hex');
      if (
        !helperStatus.isFile() ||
        helperStatus.dev !== pathStatus.dev ||
        helperStatus.ino !== pathStatus.ino ||
        (helperStatus.mode & 0o777) !== 0o500 ||
        helperStatus.uid !== this.effectiveUserId ||
        digest !== manifest.targets['linux-x64-gnu'].sha256
      ) {
        closeSync(descriptor);
        descriptor = -1;
        return { ok: false, error: error('LOCAL_EXPORT_UNAVAILABLE') };
      }
      return {
        ok: true,
        value: Object.freeze({
          ...parsedPath,
          helperHandle: { descriptor, released: false },
        }),
      };
    } catch {
      if (manifestDescriptor >= 0) closeSync(manifestDescriptor);
      if (descriptor >= 0) closeSync(descriptor);
      return { ok: false, error: error('LOCAL_EXPORT_UNAVAILABLE') };
    }
  }

  release(intent: LocalExportPreparedIntentV1): void {
    if (intent.helperHandle.released) return;
    intent.helperHandle.released = true;
    closeSync(intent.helperHandle.descriptor);
  }

  async publish(
    intent: LocalExportPreparedIntentV1,
    artifact: LocalExportArtifactV1,
    signal?: AbortSignal,
  ): Promise<LocalExportPublishResultV1> {
    const closed = (result: LocalExportPublishResultV1): LocalExportPublishResultV1 => {
      this.release(intent);
      return result;
    };
    if (
      artifact.format !== intent.format ||
      !Number.isSafeInteger(artifact.contentLength) ||
      artifact.contentLength < 1 ||
      artifact.contentLength > LOCAL_EXPORT_MAX_BYTES_V1
    )
      return closed({ ok: false, error: error('LOCAL_EXPORT_CORRUPT') });
    const expectedContentType =
      intent.format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (artifact.contentType !== expectedContentType)
      return closed({ ok: false, error: error('LOCAL_EXPORT_CORRUPT') });

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = artifact.body.getReader();
    } catch {
      return closed({ ok: false, error: error('LOCAL_EXPORT_CORRUPT') });
    }
    let rootDescriptor = -1;
    let child: ChildProcessWithoutNullStreams | undefined;
    let control: NodeJS.WritableStream | undefined;
    let overflow = false;
    let downloadFailed = false;
    let payloadForwarded = false;
    const abort = (): void => {
      child?.kill('SIGTERM');
      if (child !== undefined && !payloadForwarded) {
        destroyStreamV1(control ?? null);
        destroyStreamV1(child.stdin);
      } else if (child !== undefined) {
        void waitForChildExitBoundedV1(child, 250).then((exited) => {
          if (!exited) child?.kill('SIGKILL');
        });
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const readNext = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        try {
          return await readWithSignalV1(reader, signal);
        } catch (readError) {
          if (signal?.aborted !== true) downloadFailed = true;
          throw readError;
        }
      };
      const prefix: Buffer[] = [];
      let prefixBytes = 0;
      while (prefixBytes < 5) {
        const next = await readNext();
        if (next.done) return { ok: false, error: error('LOCAL_EXPORT_SHORT') };
        const bytes = Buffer.from(next.value);
        prefix.push(bytes);
        prefixBytes += bytes.byteLength;
      }
      const initial = Buffer.concat(prefix, prefixBytes);
      if (!signatureMatchesV1(intent.format, initial)) {
        this.release(intent);
        cancelReaderBestEffortV1(reader);
        return { ok: false, error: error('LOCAL_EXPORT_CORRUPT') };
      }

      signal?.throwIfAborted();
      rootDescriptor = openSync('/', fsConstants.O_RDONLY | LINUX_O_DIRECTORY | LINUX_O_CLOEXEC);
      if (intent.helperHandle.released)
        return { ok: false, error: error('LOCAL_EXPORT_UNAVAILABLE') };
      const spawned = this.spawnProcess('/proc/self/fd/5', [], {
        stdio: ['pipe', 'pipe', 'pipe', rootDescriptor, 'pipe', intent.helperHandle.descriptor],
        windowsHide: true,
        env: { PATH: '/usr/bin:/bin' },
      });
      this.release(intent);
      if (
        spawned.stdin === null ||
        spawned.stdout === null ||
        spawned.stderr === null ||
        spawned.stdio[4] === null
      )
        throw new Error('local export helper descriptors unavailable');
      child = spawned as ChildProcessWithoutNullStreams;
      control = child.stdio[4] as NodeJS.WritableStream;
      child.stdin.on('error', () => undefined);
      const stdoutPromise = collectBoundedV1(
        child,
        child.stdout,
        LOCAL_EXPORT_MAX_STDOUT_BYTES_V1,
        () => {
          overflow = true;
          child?.kill('SIGTERM');
        },
      );
      const stderrPromise = collectBoundedV1(
        child,
        child.stderr,
        LOCAL_EXPORT_MAX_STDERR_BYTES_V1,
        () => {
          overflow = true;
          child?.kill('SIGTERM');
        },
      );
      const exitPromise = waitForExitV1(child);
      const completion = Promise.all([stdoutPromise, stderrPromise, exitPromise]);
      void completion.catch(() => undefined);
      await endWritableV1(
        control,
        encodeLocalExportControlFrameV1(intent, artifact.contentLength),
        signal,
      );
      let received = 0;
      const forward = async (bytes: Buffer): Promise<void> => {
        received += bytes.byteLength;
        if (received > artifact.contentLength || received > LOCAL_EXPORT_MAX_BYTES_V1) {
          overflow = true;
          child?.kill('SIGTERM');
          return;
        }
        await writeWithBackpressureV1(child as ChildProcessWithoutNullStreams, bytes, signal);
      };
      await forward(initial);
      while (!overflow) {
        const next = await readNext();
        if (next.done) break;
        await forward(Buffer.from(next.value));
      }
      payloadForwarded = true;
      await endWritableV1(child.stdin, Buffer.alloc(0));
      const [stdout, stderr, exited] = await completion;
      const diagnosticText = new TextDecoder('utf-8', { fatal: true }).decode(stderr);
      if (
        diagnosticText !== '' &&
        !/^(?:SBEX\/1 io (?:openat|fstat|write|fsync|publish|unlink) errno=[0-9]+\n)+$/u.test(
          diagnosticText,
        )
      )
        return { ok: false, error: error('LOCAL_EXPORT_CORRUPT') };
      if (overflow || received > artifact.contentLength)
        return { ok: false, error: error('LOCAL_EXPORT_CORRUPT') };
      if (received < artifact.contentLength)
        return { ok: false, error: error('LOCAL_EXPORT_SHORT') };
      const line = stdout.toString('ascii');
      const match =
        /^SBEX\/1 (ok|exists|invalid|unsupported|io|short|corrupt) (0|[1-9][0-9]*)\n$/u.exec(line);
      if (match === null) {
        if (signal?.aborted === true) return { ok: false, error: error('LOCAL_EXPORT_CANCELLED') };
        return { ok: false, error: error('LOCAL_EXPORT_CORRUPT') };
      }
      const resultCode = match[1] as
        | 'ok'
        | 'exists'
        | 'invalid'
        | 'unsupported'
        | 'io'
        | 'short'
        | 'corrupt';
      const bytes = Number(match[2]);
      if (resultCode === 'ok') {
        if (bytes !== artifact.contentLength)
          return { ok: false, error: error('LOCAL_EXPORT_CORRUPT') };
        return {
          ok: true,
          value: { format: intent.format, bytes, fileName: intent.displayName },
        };
      }
      if (exited.signal !== null || exited.code !== 0) {
        if (signal?.aborted === true) return { ok: false, error: error('LOCAL_EXPORT_CANCELLED') };
        return { ok: false, error: error('LOCAL_EXPORT_CORRUPT') };
      }
      if (signal?.aborted === true) return { ok: false, error: error('LOCAL_EXPORT_CANCELLED') };
      if (bytes !== 0) return { ok: false, error: error('LOCAL_EXPORT_CORRUPT') };
      const mapped: Readonly<Record<Exclude<typeof resultCode, 'ok'>, LocalExportErrorCodeV1>> = {
        exists: 'LOCAL_EXPORT_EXISTS',
        invalid: 'LOCAL_EXPORT_INVALID_PATH',
        unsupported: 'LOCAL_EXPORT_UNAVAILABLE',
        io: 'LOCAL_EXPORT_IO',
        short: 'LOCAL_EXPORT_SHORT',
        corrupt: 'LOCAL_EXPORT_CORRUPT',
      };
      return {
        ok: false,
        error: error(mapped[resultCode as Exclude<typeof resultCode, 'ok'>]),
      };
    } catch {
      if (child !== undefined)
        await terminateChildV1(child, control, payloadForwarded).catch(() => undefined);
      this.release(intent);
      if (rootDescriptor >= 0) {
        closeSync(rootDescriptor);
        rootDescriptor = -1;
      }
      cancelReaderBestEffortV1(reader);
      return {
        ok: false,
        error:
          signal?.aborted === true
            ? error('LOCAL_EXPORT_CANCELLED')
            : downloadFailed
              ? transportErrorV1()
              : overflow
                ? error('LOCAL_EXPORT_CORRUPT')
                : error('LOCAL_EXPORT_IO'),
      };
    } finally {
      this.release(intent);
      signal?.removeEventListener('abort', abort);
      if (rootDescriptor >= 0) closeSync(rootDescriptor);
      try {
        reader.releaseLock();
      } catch {
        cancelReaderBestEffortV1(reader);
      }
    }
  }
}
