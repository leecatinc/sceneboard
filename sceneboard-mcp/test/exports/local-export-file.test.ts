import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, fstatSync, openSync } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  encodeLocalExportControlFrameV1,
  LocalExportFileV1,
  type LocalExportArtifactV1,
  type LocalExportPreparedIntentV1,
} from '../../src/exports/local-export-file.js';

const packageRoot = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(packageRoot, 'native/local-export-helper.manifest.json');
const helperPath = resolve(packageRoot, 'native/linux-x64-gnu/local-export-helper');
const testRoot = process.env.SCENEBOARD_TEST_TMP_ROOT ?? tmpdir();
const helperSourcePath = resolve(packageRoot, 'native/local-export-helper.c');

const compileFaultInjectionHelper = async (directory: string): Promise<string> => {
  const output = join(directory, 'local-export-helper-fault-injection');
  const compiled = spawnSync(
    'cc',
    [
      '-std=c17',
      '-D_FORTIFY_SOURCE=2',
      '-DSCENEBOARD_HELPER_FAULT_INJECTION',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-o',
      output,
      helperSourcePath,
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
  );
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  await chmod(output, 0o500);
  return output;
};

const runFaultInjectionHelper = async (
  executable: string,
  outputFile: string,
  fault:
    | 'fallback-temporary-unlink'
    | 'directory-fsync'
    | 'post-rename-sigterm'
    | 'post-rename-sigint'
    | 'post-link-sigterm'
    | 'post-link-sigint'
    | 'replace-before-directory-fsync'
    | 'replace-before-sigterm'
    | 'replace-before-sigint',
): Promise<{ stdout: string; exitCode: number | null }> => {
  const bytes = Buffer.from('%PDF-fault-injection', 'ascii');
  const rootDescriptor = openSync('/', 0);
  const child = spawn(executable, [], {
    stdio: ['pipe', 'pipe', 'ignore', rootDescriptor, 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      SCENEBOARD_HELPER_TEST_FAULT: fault,
    },
  });
  closeSync(rootDescriptor);
  const stdout: Buffer[] = [];
  assert(child.stdout !== null);
  assert(child.stdin !== null);
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  const control = child.stdio[4] as NodeJS.WritableStream;
  control.end(
    encodeLocalExportControlFrameV1(
      {
        format: 'pdf',
        components: outputFile.slice(1).split('/'),
        normalizedPathBytes: Buffer.byteLength(outputFile, 'utf8'),
      },
      bytes.byteLength,
    ),
  );
  child.stdin.end(bytes);
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  });
  return { stdout: Buffer.concat(stdout).toString('ascii'), exitCode };
};

const stream = (bytes: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const artifact = (
  format: 'pdf' | 'pptx',
  bytes: Buffer,
  contentLength = bytes.byteLength,
): LocalExportArtifactV1 => ({
  format,
  contentType:
    format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  contentLength,
  body: stream(bytes),
});

const createRoot = async (): Promise<string> => {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'sceneboard-local-export-'));
  await chmod(root, 0o700);
  return root;
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const promptly = async <Value>(promise: Promise<Value>, timeoutMs = 1_200): Promise<Value> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle promptly')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const stallingSink = async (
  root: string,
  mode: 'prefix' | 'body' | 'control' | 'control_error' | 'backpressure' | 'exit',
  uncooperative = false,
): Promise<{
  local: LocalExportFileV1;
  reached: Promise<void>;
  kills: NodeJS.Signals[];
  spawnCalls: () => number;
  rootDescriptorReleased: () => boolean;
  streamsDestroyed: () => boolean;
}> => {
  const bundle = `${root}/fake-helper-${mode}`;
  const native = `${bundle}/linux-x64-gnu`;
  await mkdir(native, { recursive: true, mode: 0o700 });
  const fixtureManifest = `${bundle}/local-export-helper.manifest.json`;
  const fixtureHelper = `${native}/local-export-helper`;
  const helperBytes = Buffer.from(`synthetic-${mode}`, 'ascii');
  const digest = createHash('sha256').update(helperBytes).digest('hex');
  await writeFile(fixtureHelper, helperBytes, { mode: 0o500 });
  await writeFile(
    fixtureManifest,
    JSON.stringify({
      version: 1,
      targets: {
        'linux-x64-gnu': {
          path: 'linux-x64-gnu/local-export-helper',
          sha256: digest,
          mode: '0500',
        },
      },
    }),
    { mode: 0o400 },
  );
  await chmod(fixtureHelper, 0o500);
  await chmod(fixtureManifest, 0o400);

  const milestone = deferred();
  let milestoneReached = false;
  const reach = (): void => {
    if (milestoneReached) return;
    milestoneReached = true;
    milestone.resolve();
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    highWaterMark: mode === 'backpressure' ? 1 : undefined,
    write(_chunk, _encoding, callback) {
      if (mode === 'body' || mode === 'backpressure') reach();
      if (mode !== 'backpressure') callback();
    },
    final(callback) {
      if (mode === 'exit') {
        stdout.end('SBEX/1 ok 5\n');
        stderr.end();
        reach();
      }
      callback();
    },
  });
  const control = new Writable({
    write(_chunk, _encoding, callback) {
      if (mode === 'control') reach();
      if (mode !== 'control') callback();
    },
  });
  if (mode === 'control_error') {
    control.end = (() => {
      reach();
      throw new Error('synthetic control failure');
    }) as typeof control.end;
  }
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: unknown[];
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [stdin, stdout, stderr, null, control, null];
  child.exitCode = null;
  child.signalCode = null;
  const kills: NodeJS.Signals[] = [];
  let exited = false;
  child.kill = (signal = 'SIGTERM') => {
    kills.push(signal);
    if (exited || ((mode === 'exit' || uncooperative) && signal !== 'SIGKILL')) return true;
    exited = true;
    setImmediate(() => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
    });
    return true;
  };
  let spawnCalls = 0;
  let rootDescriptor: number | null = null;
  const local = new LocalExportFileV1({
    manifestPath: fixtureManifest,
    platform: 'linux',
    architecture: 'x64',
    glibc: true,
    spawn: ((
      _command: string,
      _args: readonly string[],
      options: { stdio?: readonly unknown[] },
    ) => {
      spawnCalls += 1;
      const descriptor = options.stdio?.[3];
      rootDescriptor = typeof descriptor === 'number' ? descriptor : null;
      return child as never;
    }) as unknown as typeof spawn,
  });
  return {
    local,
    reached: milestone.promise,
    kills,
    spawnCalls: () => spawnCalls,
    rootDescriptorReleased: () => {
      if (rootDescriptor === null) return false;
      try {
        fstatSync(rootDescriptor);
        return false;
      } catch {
        return true;
      }
    },
    streamsDestroyed: () =>
      stdin.destroyed && stdout.destroyed && stderr.destroyed && control.destroyed,
  };
};

const sink = (): LocalExportFileV1 =>
  new LocalExportFileV1({
    manifestPath,
    platform: 'linux',
    architecture: 'x64',
    glibc: true,
  });

const prepared = (
  local: LocalExportFileV1,
  outputFile: string,
  format: 'pdf' | 'pptx',
): LocalExportPreparedIntentV1 => {
  const result = local.preflight(outputFile, format);
  if (!result.ok) throw new Error(result.error.code);
  assert.equal(result.ok, true);
  return result.value;
};

test('preflight rejects unsupported targets before touching a missing manifest', () => {
  const local = new LocalExportFileV1({
    manifestPath: '/does/not/exist/local-export-helper.manifest.json',
    platform: 'win32',
    architecture: 'x64',
    glibc: false,
  });
  assert.deepEqual(local.preflight('C:\\synthetic.pdf', 'pdf'), {
    ok: false,
    error: {
      code: 'LOCAL_EXPORT_UNAVAILABLE',
      message: 'Secure local export is unavailable on this platform',
      retryable: false,
      details: null,
    },
  });
});

test('preflight accepts only strict absolute NFC non-glob paths with exact extension', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    for (const path of [
      'relative.pdf',
      `${root}/`,
      `${root}/../escape.pdf`,
      `${root}/wild*.pdf`,
      `${root}/wrong.pptx`,
      `${root}/UPPER.PDF`,
      `${root}/e\u0301.pdf`,
    ])
      assert.equal(local.preflight(path, 'pdf').ok, false, path);
    for (const [path, format] of [
      [`${root}/valid.pdf`, 'pdf'],
      [`${root}/발표자료.pptx`, 'pptx'],
    ] as const) {
      const valid = local.preflight(path, format);
      assert.equal(valid.ok, true);
      if (valid.ok) local.release(valid.value);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publishes valid PDF and PPTX bytes once without exposing parent paths', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    const pdfBytes = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF\n', 'ascii');
    const pptxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const pdfPath = `${root}/synthetic.pdf`;
    const pptxPath = `${root}/synthetic.pptx`;
    assert.deepEqual(
      await local.publish(prepared(local, pdfPath, 'pdf'), artifact('pdf', pdfBytes)),
      {
        ok: true,
        value: { format: 'pdf', bytes: pdfBytes.byteLength, fileName: 'synthetic.pdf' },
      },
    );
    assert.deepEqual(
      await local.publish(prepared(local, pptxPath, 'pptx'), artifact('pptx', pptxBytes)),
      {
        ok: true,
        value: { format: 'pptx', bytes: pptxBytes.byteLength, fileName: 'synthetic.pptx' },
      },
    );
    assert.deepEqual(await readFile(pdfPath), pdfBytes);
    assert.deepEqual(await readFile(pptxPath), pptxBytes);
    assert.equal((await lstat(pdfPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(pptxPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('never overwrites an existing or concurrently published target', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    const bytes = Buffer.from('%PDF-1.7\none\n%%EOF\n', 'ascii');
    const target = `${root}/collision.pdf`;
    await writeFile(target, 'keep', { mode: 0o600 });
    const collision = await local.publish(prepared(local, target, 'pdf'), artifact('pdf', bytes));
    assert.equal(collision.ok, false);
    if (!collision.ok) assert.equal(collision.error.code, 'LOCAL_EXPORT_EXISTS');
    assert.equal(await readFile(target, 'utf8'), 'keep');

    const concurrent = `${root}/concurrent.pdf`;
    const results = await Promise.all([
      local.publish(prepared(local, concurrent, 'pdf'), artifact('pdf', bytes)),
      local.publish(prepared(local, concurrent, 'pdf'), artifact('pdf', bytes)),
    ]);
    assert.deepEqual(results.map((result) => (result.ok ? 'ok' : result.error.code)).sort(), [
      'LOCAL_EXPORT_EXISTS',
      'ok',
    ]);
    assert.deepEqual(await readFile(concurrent), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects symlink parents and hard-linked leaves without redirect or overwrite', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    const real = `${root}/real`;
    await mkdir(real, { mode: 0o700 });
    await symlink(real, `${root}/alias`, 'dir');
    const bytes = Buffer.from('%PDF-1.7\nsafe\n%%EOF\n', 'ascii');
    const symlinkResult = await local.publish(
      prepared(local, `${root}/alias/redirect.pdf`, 'pdf'),
      artifact('pdf', bytes),
    );
    assert.equal(symlinkResult.ok, false);
    if (!symlinkResult.ok) assert.equal(symlinkResult.error.code, 'LOCAL_EXPORT_INVALID_PATH');
    assert.equal((await readdir(real)).includes('redirect.pdf'), false);

    await writeFile(`${root}/source.pdf`, 'keep', { mode: 0o600 });
    await link(`${root}/source.pdf`, `${root}/hard.pdf`);
    const hardResult = await local.publish(
      prepared(local, `${root}/hard.pdf`, 'pdf'),
      artifact('pdf', bytes),
    );
    assert.equal(hardResult.ok, false);
    if (!hardResult.ok) assert.equal(hardResult.error.code, 'LOCAL_EXPORT_EXISTS');
    assert.equal(await readFile(`${root}/source.pdf`, 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('held directory descriptors defeat a parent replacement race', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    const parent = `${root}/parent`;
    const held = `${root}/held`;
    const attacker = `${root}/attacker`;
    await mkdir(parent, { mode: 0o700 });
    await mkdir(attacker, { mode: 0o700 });
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(Buffer.from('%PDF-', 'ascii'));
      },
    });
    const pending = local.publish(prepared(local, `${parent}/race.pdf`, 'pdf'), {
      format: 'pdf',
      contentType: 'application/pdf',
      contentLength: 9,
      body,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const names = await readdir(parent);
      if (names.some((name) => name.startsWith('.sceneboard-export-'))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    await rename(parent, held);
    await symlink(attacker, parent, 'dir');
    streamController?.enqueue(Buffer.from('tail', 'ascii'));
    streamController?.close();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(await readFile(`${held}/race.pdf`, 'utf8'), '%PDF-tail');
    assert.deepEqual(await readdir(attacker), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executes the verified held helper descriptor after its path is replaced', async () => {
  const root = await createRoot();
  try {
    const bundle = `${root}/bundle`;
    const native = `${bundle}/linux-x64-gnu`;
    await mkdir(native, { recursive: true, mode: 0o700 });
    const fixtureManifest = `${bundle}/local-export-helper.manifest.json`;
    const fixtureHelper = `${native}/local-export-helper`;
    await copyFile(manifestPath, fixtureManifest);
    await copyFile(helperPath, fixtureHelper);
    for (const [path, mode] of [
      [fixtureManifest, 0o400],
      [fixtureHelper, 0o500],
    ] as const) {
      spawnSync('/usr/bin/setfacl', ['-b', path], { stdio: 'ignore' });
      await chmod(path, mode);
    }
    const local = new LocalExportFileV1({
      manifestPath: fixtureManifest,
      platform: 'linux',
      architecture: 'x64',
      glibc: true,
    });
    const target = `${root}/held-helper.pdf`;
    const intent = prepared(local, target, 'pdf');
    await rename(fixtureHelper, `${fixtureHelper}.verified`);
    await writeFile(fixtureHelper, '#!/bin/sh\nexit 99\n', { mode: 0o500 });
    spawnSync('/usr/bin/setfacl', ['-b', fixtureHelper], { stdio: 'ignore' });
    await chmod(fixtureHelper, 0o500);
    const bytes = Buffer.from('%PDF-held', 'ascii');
    const result = await local.publish(intent, artifact('pdf', bytes));
    assert.equal(result.ok, true);
    assert.deepEqual(await readFile(target), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery removes only old helper-shaped private residue', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    const residue = `${root}/.sceneboard-export-${'a'.repeat(32)}.tmp`;
    const unrelated = `${root}/.sceneboard-export-${'z'.repeat(32)}.tmp`;
    await writeFile(residue, 'old', { mode: 0o600 });
    await writeFile(unrelated, 'keep', { mode: 0o600 });
    const old = new Date(Date.now() - 600_000);
    await utimes(residue, old, old);
    await utimes(unrelated, old, old);
    const bytes = Buffer.from('%PDF-ok', 'ascii');
    const target = `${root}/recovered.pdf`;
    const result = await local.publish(prepared(local, target, 'pdf'), artifact('pdf', bytes));
    assert.equal(result.ok, true);
    await assert.rejects(lstat(residue), { code: 'ENOENT' });
    assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('signature, short body and abort failures publish nothing and clean helper temps', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    const invalidPath = `${root}/invalid.pdf`;
    const invalid = await local.publish(
      prepared(local, invalidPath, 'pdf'),
      artifact('pdf', Buffer.from('not-a-pdf')),
    );
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, 'LOCAL_EXPORT_CORRUPT');

    const shortPath = `${root}/short.pdf`;
    const shortBytes = Buffer.from('%PDF-', 'ascii');
    const short = await local.publish(
      prepared(local, shortPath, 'pdf'),
      artifact('pdf', shortBytes, shortBytes.byteLength + 10),
    );
    assert.equal(short.ok, false);
    if (!short.ok) assert.equal(short.error.code, 'LOCAL_EXPORT_SHORT');

    const controller = new AbortController();
    const abortPath = `${root}/abort.pdf`;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(Buffer.from('%PDF-', 'ascii'));
      },
      cancel() {},
    });
    const pending = local.publish(
      prepared(local, abortPath, 'pdf'),
      {
        format: 'pdf',
        contentType: 'application/pdf',
        contentLength: 10_000,
        body,
      },
      controller.signal,
    );
    setImmediate(() => controller.abort());
    const aborted = await pending;
    assert.equal(aborted.ok, false);
    if (!aborted.ok) assert.equal(aborted.error.code, 'LOCAL_EXPORT_CANCELLED');
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('.sceneboard-export-')),
      [],
    );
    for (const path of [invalidPath, shortPath, abortPath])
      await assert.rejects(lstat(path), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('abort cancels a stalled prefix read before spawning the local helper', async () => {
  const root = await createRoot();
  try {
    const fixture = await stallingSink(root, 'prefix');
    const target = `${root}/stalled-prefix.pdf`;
    const controller = new AbortController();
    const pending = fixture.local.publish(
      prepared(fixture.local, target, 'pdf'),
      {
        format: 'pdf',
        contentType: 'application/pdf',
        contentLength: 5,
        body: new ReadableStream<Uint8Array>({ pull() {} }),
      },
      controller.signal,
    );
    setImmediate(() => controller.abort());
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'LOCAL_EXPORT_CANCELLED');
    assert.equal(fixture.spawnCalls(), 0);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pre-spawn corruption does not await a never-settling response cancellation', async () => {
  const root = await createRoot();
  try {
    const fixture = await stallingSink(root, 'prefix');
    const target = `${root}/never-cancel-prefix.pdf`;
    let cancelCalls = 0;
    const intent = prepared(fixture.local, target, 'pdf');
    const pending = fixture.local.publish(intent, {
      format: 'pdf',
      contentType: 'application/pdf',
      contentLength: 9,
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(Buffer.from('not-a-pdf', 'ascii'));
        },
        cancel() {
          cancelCalls += 1;
          return new Promise<void>(() => undefined);
        },
      }),
    });
    const result = await promptly(pending);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'LOCAL_EXPORT_CORRUPT');
    assert.equal(cancelCalls, 1);
    assert.equal(fixture.spawnCalls(), 0);
    assert.equal(intent.helperHandle.released, true);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('post-spawn failure reaps and releases before ignoring never-settling cancellation', async () => {
  const root = await createRoot();
  try {
    const fixture = await stallingSink(root, 'control_error', true);
    const target = `${root}/never-cancel-body.pdf`;
    let cancelCalls = 0;
    const intent = prepared(fixture.local, target, 'pdf');
    const pending = fixture.local.publish(intent, {
      format: 'pdf',
      contentType: 'application/pdf',
      contentLength: 10,
      body: new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(Buffer.from('%PDF-', 'ascii'));
        },
        cancel() {
          cancelCalls += 1;
          return new Promise<void>(() => undefined);
        },
      }),
    });
    await fixture.reached;
    const result = await promptly(pending);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'LOCAL_EXPORT_IO');
    assert.equal(cancelCalls, 1);
    assert.equal(fixture.kills.includes('SIGTERM'), true);
    assert.equal(fixture.kills.includes('SIGKILL'), true);
    assert.equal(intent.helperHandle.released, true);
    assert.equal(fixture.rootDescriptorReleased(), true);
    assert.equal(fixture.streamsDestroyed(), true);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('.sceneboard-export-')),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('abort bounds stalled body, control, backpressure, and helper-exit waits', async () => {
  const root = await createRoot();
  try {
    for (const mode of ['body', 'control', 'backpressure', 'exit'] as const) {
      const fixture = await stallingSink(root, mode);
      const target = `${root}/stalled-${mode}.pdf`;
      const controller = new AbortController();
      const body =
        mode === 'body'
          ? new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(Buffer.from('%PDF-', 'ascii'));
              },
            })
          : stream(Buffer.from('%PDF-', 'ascii'));
      const pending = fixture.local.publish(
        prepared(fixture.local, target, 'pdf'),
        {
          format: 'pdf',
          contentType: 'application/pdf',
          contentLength: mode === 'body' ? 10 : 5,
          body,
        },
        controller.signal,
      );
      await fixture.reached;
      controller.abort();
      const result = await pending;
      assert.equal(result.ok, false, mode);
      if (!result.ok) assert.equal(result.error.code, 'LOCAL_EXPORT_CANCELLED', mode);
      assert.equal(fixture.spawnCalls(), 1, mode);
      assert.equal(fixture.kills.includes('SIGTERM'), true, mode);
      if (mode === 'exit') assert.equal(fixture.kills.includes('SIGKILL'), true, mode);
      await assert.rejects(lstat(target), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('response-stream failure remains retryable transport without publishing', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    const target = `${root}/transport.pdf`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('%PDF-', 'ascii'));
      },
      pull(controller) {
        controller.error(new Error('synthetic reset'));
      },
    });
    const result = await local.publish(prepared(local, target, 'pdf'), {
      format: 'pdf',
      contentType: 'application/pdf',
      contentLength: 10,
      body,
    });
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'BOARD_MCP_TRANSPORT_ERROR',
        message: 'SceneBoard transport is unavailable',
        retryable: true,
        details: { phase: 'response' },
      },
    });
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('.sceneboard-export-')),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('control ABI rejects unknown version and trailing control bytes before walking', async () => {
  const root = await createRoot();
  try {
    const local = sink();
    const intent = prepared(local, `${root}/raw.pdf`, 'pdf');
    const run = async (mutate: (frame: Buffer) => Buffer): Promise<string> => {
      const rootDescriptor = openSync('/', 0);
      const child = spawn(helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', rootDescriptor, 'pipe'],
        env: { PATH: '/usr/bin:/bin' },
      });
      closeSync(rootDescriptor);
      const output: Buffer[] = [];
      const streamErrors: NodeJS.ErrnoException[] = [];
      assert(child.stdout !== null);
      assert(child.stdin !== null);
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stdin.on('error', (error: NodeJS.ErrnoException) => streamErrors.push(error));
      const control = child.stdio[4] as NodeJS.WritableStream;
      control.on('error', (error: NodeJS.ErrnoException) => streamErrors.push(error));
      const frame = mutate(encodeLocalExportControlFrameV1(intent, 5));
      control.end(frame);
      child.stdin.end(Buffer.from('%PDF-', 'ascii'));
      await new Promise<void>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', () => resolveExit());
      });
      assert(
        streamErrors.every(
          (error) => error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED',
        ),
      );
      return Buffer.concat(output).toString('ascii');
    };
    assert.equal(
      await run((frame) => {
        const changed = Buffer.from(frame);
        changed.writeUInt16BE(2, 8);
        return changed;
      }),
      'SBEX/1 invalid 0\n',
    );
    assert.equal(
      await run((frame) => Buffer.concat([frame, Buffer.from([0])])),
      'SBEX/1 invalid 0\n',
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication failures roll back only files created by this helper invocation', async () => {
  const root = await createRoot();
  try {
    const executable = await compileFaultInjectionHelper(root);
    const fallbackDirectory = `${root}/fallback`;
    const fsyncDirectory = `${root}/fsync`;
    const collisionDirectory = `${root}/collision`;
    await Promise.all(
      [fallbackDirectory, fsyncDirectory, collisionDirectory].map((directory) =>
        mkdir(directory, { mode: 0o700 }),
      ),
    );

    assert.deepEqual(
      await runFaultInjectionHelper(
        executable,
        `${fallbackDirectory}/fallback.pdf`,
        'fallback-temporary-unlink',
      ),
      { stdout: 'SBEX/1 io 0\n', exitCode: 0 },
    );
    assert.deepEqual(await readdir(fallbackDirectory), []);

    assert.deepEqual(
      await runFaultInjectionHelper(executable, `${fsyncDirectory}/fsync.pdf`, 'directory-fsync'),
      { stdout: 'SBEX/1 io 0\n', exitCode: 0 },
    );
    assert.deepEqual(await readdir(fsyncDirectory), []);

    const existing = `${collisionDirectory}/existing.pdf`;
    await writeFile(existing, 'keep', { mode: 0o600 });
    assert.deepEqual(
      await runFaultInjectionHelper(executable, existing, 'fallback-temporary-unlink'),
      { stdout: 'SBEX/1 exists 0\n', exitCode: 0 },
    );
    assert.deepEqual(await readdir(collisionDirectory), ['existing.pdf']);
    assert.equal(await readFile(existing, 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication transitions are signal-safe and cleanup is identity-bound', async () => {
  const root = await createRoot();
  try {
    const executable = await compileFaultInjectionHelper(root);
    const fsyncReplacementDirectory = `${root}/fsync-replacement`;
    const collisionDirectory = `${root}/collision`;
    const signalCases = [
      ['rename-sigterm', 'post-rename-sigterm'],
      ['rename-sigint', 'post-rename-sigint'],
      ['link-sigterm', 'post-link-sigterm'],
      ['link-sigint', 'post-link-sigint'],
    ] as const;
    const replacementSignalCases = [
      ['replacement-sigterm', 'replace-before-sigterm'],
      ['replacement-sigint', 'replace-before-sigint'],
    ] as const;
    await Promise.all(
      [
        fsyncReplacementDirectory,
        collisionDirectory,
        ...signalCases.map(([directory]) => `${root}/${directory}`),
        ...replacementSignalCases.map(([directory]) => `${root}/${directory}`),
      ].map((directory) => mkdir(directory, { mode: 0o700 })),
    );

    for (const [directory, fault] of signalCases) {
      const path = `${root}/${directory}`;
      assert.deepEqual(await runFaultInjectionHelper(executable, `${path}/signal.pdf`, fault), {
        stdout: 'SBEX/1 io 0\n',
        exitCode: 143,
      });
      assert.deepEqual(await readdir(path), []);
    }

    const fsyncReplacement = `${fsyncReplacementDirectory}/replacement.pdf`;
    assert.deepEqual(
      await runFaultInjectionHelper(executable, fsyncReplacement, 'replace-before-directory-fsync'),
      { stdout: 'SBEX/1 io 0\n', exitCode: 0 },
    );
    assert.deepEqual(await readdir(fsyncReplacementDirectory), ['replacement.pdf']);
    assert.equal(await readFile(fsyncReplacement, 'utf8'), '%PDF-replacement');

    for (const [directory, fault] of replacementSignalCases) {
      const path = `${root}/${directory}`;
      const replacement = `${path}/replacement.pdf`;
      assert.deepEqual(await runFaultInjectionHelper(executable, replacement, fault), {
        stdout: 'SBEX/1 io 0\n',
        exitCode: 143,
      });
      assert.deepEqual(await readdir(path), ['replacement.pdf']);
      assert.equal(await readFile(replacement, 'utf8'), '%PDF-replacement');
    }

    const existing = `${collisionDirectory}/existing.pdf`;
    await writeFile(existing, 'keep-byte-for-byte', { mode: 0o600 });
    assert.deepEqual(await runFaultInjectionHelper(executable, existing, 'post-link-sigterm'), {
      stdout: 'SBEX/1 exists 0\n',
      exitCode: 0,
    });
    assert.deepEqual(await readdir(collisionDirectory), ['existing.pdf']);
    assert.equal(await readFile(existing, 'utf8'), 'keep-byte-for-byte');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
