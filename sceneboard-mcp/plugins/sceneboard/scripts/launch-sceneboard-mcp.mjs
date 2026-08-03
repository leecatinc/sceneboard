#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  configResolutionFailureCodeV1,
  resolveSceneBoardServer,
  sceneBoardLaunchFailureLineV1,
} from './sceneboard-mcp-config.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releasePointerName = '.sceneboard-current';
const releaseStoreName = '.sceneboard-releases';
const leaseStoreName = '.sceneboard-leases';
const releaseNamePattern = /^generation-[A-Za-z0-9-]+$/u;
const accountApiKeyPattern = /^sbk_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const runtimeSafeEnvironmentNames = [
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
];

const fail = (code) => {
  process.stderr.write(sceneBoardLaunchFailureLineV1(code));
  process.exitCode = 78;
};

const openProductionRoot = async (currentUid) => {
  const pluginHandle = await open(
    pluginRoot,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
  );
  const heldPluginRoot = `/proc/self/fd/${pluginHandle.fd}`;
  let leaseStoreHandle;
  let acquisitionHandle;
  let acquisitionPath = null;
  try {
    leaseStoreHandle = await open(
      `${heldPluginRoot}/${leaseStoreName}`,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_CLOEXEC,
    );
  } catch (error) {
    if (error?.code === 'ENOENT')
      return { rootHandle: pluginHandle, leaseHandle: null, leasePath: null };
    await pluginHandle.close().catch(() => undefined);
    throw error;
  }
  const leaseStoreStatus = await leaseStoreHandle.stat();
  if (
    !leaseStoreStatus.isDirectory() ||
    leaseStoreStatus.nlink < 2 ||
    leaseStoreStatus.uid !== currentUid ||
    (leaseStoreStatus.mode & 0o777) !== 0o700
  ) {
    await Promise.allSettled([leaseStoreHandle.close(), pluginHandle.close()]);
    throw new TypeError('production_native_invalid');
  }
  const acquisitionName = `acquire.${process.pid}.${randomUUID()}`;
  acquisitionPath = `${pluginRoot}/${leaseStoreName}/${acquisitionName}`;
  acquisitionHandle = await open(
    `/proc/self/fd/${leaseStoreHandle.fd}/${acquisitionName}`,
    fsConstants.O_RDONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_CLOEXEC,
    0o400,
  );
  let pointerHandle;
  try {
    pointerHandle = await open(
      `${heldPluginRoot}/${releasePointerName}`,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await acquisitionHandle.close();
      await rm(acquisitionPath, { force: true });
      await leaseStoreHandle.close();
      return { rootHandle: pluginHandle, leaseHandle: null, leasePath: null };
    }
    await acquisitionHandle.close().catch(() => undefined);
    await rm(acquisitionPath, { force: true }).catch(() => undefined);
    await leaseStoreHandle.close().catch(() => undefined);
    await pluginHandle.close().catch(() => undefined);
    throw error;
  }
  let releaseStoreHandle;
  let releaseHandle;
  let leaseHandle;
  let leasePath = null;
  try {
    const [pointerStatus, currentPointer] = await Promise.all([
      pointerHandle.stat(),
      lstat(`${heldPluginRoot}/${releasePointerName}`),
    ]);
    if (
      !pointerStatus.isFile() ||
      pointerStatus.nlink !== 1 ||
      pointerStatus.uid !== currentUid ||
      (pointerStatus.mode & 0o777) !== 0o400 ||
      !currentPointer.isFile() ||
      currentPointer.isSymbolicLink() ||
      currentPointer.dev !== pointerStatus.dev ||
      currentPointer.ino !== pointerStatus.ino
    )
      throw new TypeError('production_native_invalid');
    const pointerValue = await pointerHandle.readFile('utf8');
    const releaseName = pointerValue.trim();
    if (!releaseNamePattern.test(releaseName) || pointerValue !== `${releaseName}\n`)
      throw new TypeError('production_native_invalid');
    releaseStoreHandle = await open(
      `${heldPluginRoot}/${releaseStoreName}`,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_CLOEXEC,
    );
    for (const handle of [releaseStoreHandle, leaseStoreHandle]) {
      const status = await handle.stat();
      if (
        !status.isDirectory() ||
        status.nlink < 2 ||
        status.uid !== currentUid ||
        (status.mode & 0o777) !== 0o700
      )
        throw new TypeError('production_native_invalid');
    }
    releaseHandle = await open(
      `/proc/self/fd/${releaseStoreHandle.fd}/${releaseName}`,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_CLOEXEC,
    );
    const leaseName = `${releaseName}.${process.pid}.${randomUUID()}`;
    leasePath = `${pluginRoot}/${leaseStoreName}/${leaseName}`;
    leaseHandle = await open(
      `/proc/self/fd/${leaseStoreHandle.fd}/${leaseName}`,
      fsConstants.O_RDONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_CLOEXEC,
      0o400,
    );
    await acquisitionHandle.close();
    await rm(acquisitionPath, { force: true });
    acquisitionPath = null;
    return { rootHandle: releaseHandle, leaseHandle, leasePath };
  } catch (error) {
    await acquisitionHandle?.close().catch(() => undefined);
    if (acquisitionPath !== null) await rm(acquisitionPath, { force: true }).catch(() => undefined);
    await leaseHandle?.close().catch(() => undefined);
    if (leasePath !== null) await rm(leasePath, { force: true }).catch(() => undefined);
    await releaseHandle?.close().catch(() => undefined);
    throw error;
  } finally {
    await Promise.allSettled(
      [pointerHandle, releaseStoreHandle, leaseStoreHandle, pluginHandle]
        .filter(Boolean)
        .map((handle) => handle.close()),
    );
  }
};

const normalizeProductionHelpers = async () => {
  if (process.platform !== 'linux') return null;
  const currentUid = process.geteuid?.();
  if (currentUid === undefined) throw new TypeError('production_native_invalid');
  const directoryNames = ['.', 'runtime', 'native', 'native/linux-x64-gnu'];
  const fileTargets = [
    ['runtime/index.js', 0o644],
    ['native/profile-lease-helper', 0o500],
    ['native/profile-lease-helper.sha256', 0o400],
    ['native/linux-x64-gnu/local-export-helper', 0o500],
    ['native/linux-x64-gnu/local-export-helper.sha256', 0o400],
    ['native/local-export-helper.manifest.json', 0o400],
  ];
  const production = await openProductionRoot(currentUid);
  const rootHandle = production.rootHandle;
  const heldRoot = `/proc/self/fd/${rootHandle.fd}`;
  const directoryHandles = [rootHandle];
  const fileHandles = [];
  let accepted = false;
  try {
    for (const name of directoryNames) {
      const handle =
        name === '.'
          ? rootHandle
          : await open(
              `${heldRoot}/${name}`,
              fsConstants.O_RDONLY |
                fsConstants.O_DIRECTORY |
                fsConstants.O_NOFOLLOW |
                fsConstants.O_CLOEXEC,
            );
      if (handle !== rootHandle) directoryHandles.push(handle);
      const status = await handle.stat();
      if (
        !status.isDirectory() ||
        status.nlink < 2 ||
        (status.uid !== currentUid && status.uid !== 0) ||
        (status.mode & 0o022) !== 0
      )
        throw new TypeError('production_native_invalid');
    }
    for (const [index, [name, mode]] of fileTargets.entries()) {
      const path = `${heldRoot}/${name}`;
      const handle = await open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
      );
      fileHandles.push(handle);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== currentUid)
        throw new TypeError('production_native_invalid');
      if (
        index === 0 &&
        process.env.SCENEBOARD_PLUGIN_LAUNCH_TEST_FAULT === 'pause-before-first-chmod' &&
        typeof process.send === 'function'
      ) {
        process.send({ event: 'sceneboard_plugin_before_first_chmod' });
        await new Promise((resolveResume, rejectResume) => {
          const timeout = setTimeout(
            () => rejectResume(new TypeError('production_native_invalid')),
            2_000,
          );
          process.once('message', (message) => {
            clearTimeout(timeout);
            if (message === 'resume') resolveResume();
            else rejectResume(new TypeError('production_native_invalid'));
          });
        });
      }
      await handle.chmod(mode);
      const [after, current] = await Promise.all([handle.stat(), lstat(path)]);
      if (
        !after.isFile() ||
        after.uid !== currentUid ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        (after.mode & 0o777) !== mode ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.uid !== currentUid ||
        current.nlink !== 1 ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw new TypeError('production_native_replaced');
    }
    accepted = true;
    return production;
  } finally {
    await Promise.allSettled(
      [...fileHandles, ...directoryHandles.slice(1)].map((handle) => handle.close()),
    );
    if (!accepted) {
      await rootHandle.close().catch(() => undefined);
      await production.leaseHandle?.close().catch(() => undefined);
      if (production.leasePath !== null)
        await rm(production.leasePath, { force: true }).catch(() => undefined);
    }
  }
};

const childEnvironment = (selected) => {
  const environment = {};
  for (const name of runtimeSafeEnvironmentNames) {
    const value = process.env[name];
    if (typeof value === 'string' && !accountApiKeyPattern.test(value)) environment[name] = value;
  }
  Object.assign(environment, selected.server.env, { SCENEBOARD_CONFIG_DEPTH: '1' });
  if (
    selected.source === 'production_default' &&
    selected.server.env.BOARD_CREDENTIAL_MODE === 'api_key' &&
    selected.server.env.BOARD_ACCESS_TOKEN_REF === 'env://SCENEBOARD_API_KEY' &&
    typeof process.env.SCENEBOARD_API_KEY === 'string'
  ) {
    environment.SCENEBOARD_API_KEY = process.env.SCENEBOARD_API_KEY;
  }
  if (
    selected.source === 'production_default' &&
    selected.server.env.BOARD_CREDENTIAL_MODE === 'pairing' &&
    selected.server.env.BOARD_ACCESS_TOKEN_REF === 'env://SCENEBOARD_ACCESS_TOKEN' &&
    typeof process.env.SCENEBOARD_ACCESS_TOKEN === 'string'
  ) {
    environment.SCENEBOARD_ACCESS_TOKEN = process.env.SCENEBOARD_ACCESS_TOKEN;
  }
  return environment;
};

const awaitProductionRelease = async () => {
  let failure;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await normalizeProductionHelpers();
    } catch (error) {
      if (error instanceof TypeError && error.message === 'production_native_replaced') throw error;
      failure = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  }
  throw failure;
};

try {
  const selected = await resolveSceneBoardServer({ pluginRoot });
  let productionRoot = null;
  if (selected.source === 'production_default') {
    try {
      if (
        process.env.SCENEBOARD_PLUGIN_LAUNCH_TEST_FAULT === 'pause-before-production-release' &&
        typeof process.send === 'function'
      ) {
        process.send({ event: 'sceneboard_plugin_before_production_release' });
        await new Promise((resolveResume, rejectResume) => {
          const timeout = setTimeout(
            () => rejectResume(new TypeError('production_native_invalid')),
            2_000,
          );
          process.once('message', (message) => {
            clearTimeout(timeout);
            if (message === 'resume') resolveResume();
            else rejectResume(new TypeError('production_native_invalid'));
          });
        });
      }
      productionRoot = await awaitProductionRelease();
      if (
        process.env.SCENEBOARD_PLUGIN_LAUNCH_TEST_FAULT === 'pause-after-production-release' &&
        typeof process.send === 'function'
      ) {
        process.send({ event: 'sceneboard_plugin_after_production_release' });
        await new Promise((resolveResume, rejectResume) => {
          const timeout = setTimeout(
            () => rejectResume(new TypeError('production_native_invalid')),
            2_000,
          );
          process.once('message', (message) => {
            clearTimeout(timeout);
            if (message === 'resume') resolveResume();
            else rejectResume(new TypeError('production_native_invalid'));
          });
        });
      }
    } catch {
      fail('production_runtime_unavailable');
      process.exit();
    }
  }

  const child = spawn(
    selected.server.command,
    productionRoot === null
      ? selected.server.args
      : ['/proc/self/fd/3/runtime/index.js', ...selected.server.args.slice(1)],
    {
      cwd: selected.server.cwd ?? process.cwd(),
      env: childEnvironment(selected),
      stdio:
        productionRoot === null
          ? 'inherit'
          : [
              'inherit',
              'inherit',
              'inherit',
              productionRoot.rootHandle.fd,
              productionRoot.leaseHandle?.fd ?? 'ignore',
            ],
    },
  );
  await productionRoot?.rootHandle.close();
  await productionRoot?.leaseHandle?.close();
  const releaseLease = async () => {
    if (productionRoot?.leasePath !== null && productionRoot?.leasePath !== undefined)
      await rm(productionRoot.leasePath, { force: true }).catch(() => undefined);
  };
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.once('error', () => {
    void releaseLease();
    fail('server_process_start_failed');
  });
  child.once('exit', (code, signal) => {
    void releaseLease();
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  fail(configResolutionFailureCodeV1(error));
}
