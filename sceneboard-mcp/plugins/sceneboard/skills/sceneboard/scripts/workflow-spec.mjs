#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  WORKFLOW_SPEC_LIMITS_V1,
  WorkflowSpecError,
  canonicalizeWorkflowSpec,
  parseWorkflowSpec,
} from "./workflow-spec-core.mjs";

class WorkflowSpecIoError extends Error {
  constructor(code, path) {
    super(code);
    this.name = "WorkflowSpecIoError";
    this.code = code;
    this.path = path;
  }
}

const ioFail = (code, path) => {
  throw new WorkflowSpecIoError(code, path);
};
const statusOrNull = (path) =>
  lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });

const readSafeFile = async (path) => {
  const absolute = resolve(path);
  let before;
  try {
    before = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") ioFail("INPUT_NOT_FOUND", "/input");
    ioFail("INPUT_READ_FAILED", "/input");
  }
  if (before.isSymbolicLink()) ioFail("INPUT_SYMLINK", "/input");
  if (!before.isFile()) ioFail("INPUT_NOT_REGULAR", "/input");
  let handle;
  try {
    handle = await open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === "ELOOP") ioFail("INPUT_SYMLINK", "/input");
    ioFail("INPUT_READ_FAILED", "/input");
  }
  try {
    const opened = await handle.stat();
    const fingerprint = await handle.stat({ bigint: true });
    if (!opened.isFile()) ioFail("INPUT_NOT_REGULAR", "/input");
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      ioFail("INPUT_READ_FAILED", "/input");
    const bytes = Buffer.alloc(WORKFLOW_SPEC_LIMITS_V1.inputBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const afterFingerprint = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      afterFingerprint.dev !== fingerprint.dev ||
      afterFingerprint.ino !== fingerprint.ino ||
      afterFingerprint.size !== fingerprint.size ||
      afterFingerprint.mtimeNs !== fingerprint.mtimeNs ||
      afterFingerprint.ctimeNs !== fingerprint.ctimeNs
    )
      ioFail("INPUT_READ_FAILED", "/input");
    if (after.size > WORKFLOW_SPEC_LIMITS_V1.inputBytes)
      throw new WorkflowSpecError("LIMIT_EXCEEDED", "");
    if (after.size !== offset) ioFail("INPUT_READ_FAILED", "/input");
    try {
      return {
        absolute,
        status: opened,
        text: new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, offset),
        ),
      };
    } catch {
      throw new WorkflowSpecError("INVALID_UTF8", "");
    }
  } catch (error) {
    if (
      error instanceof WorkflowSpecError ||
      error instanceof WorkflowSpecIoError
    )
      throw error;
    ioFail("INPUT_READ_FAILED", "/input");
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const sameIdentity = (left, right) =>
  left !== null &&
  right !== null &&
  left.dev === right.dev &&
  left.ino === right.ino;

const temporaryName = (suffix) =>
  `.${process.pid}-${randomBytes(16).toString("hex")}.workflow-spec.${suffix}`;

const inheritedFileMode = async (parent) => {
  const probe = resolve(
    parent,
    temporaryName("mode"),
  );
  let handle;
  try {
    handle = await open(
      probe,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o666,
    );
    return (await handle.stat()).mode & 0o7777;
  } catch {
    ioFail("OUTPUT_TEMP_CREATE_FAILED", "/output");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(probe, { force: true }).catch(() => undefined);
  }
};

const preserveExistingMetadata = async (handle, existing) => {
  try {
    const temporary = await handle.stat();
    if (temporary.uid !== existing.uid || temporary.gid !== existing.gid)
      await handle.chown(existing.uid, existing.gid);
    await handle.chmod(existing.mode & 0o0777);
  } catch {
    ioFail("OUTPUT_SYNC_FAILED", "/output");
  }
  const applied = await handle
    .stat()
    .catch(() => ioFail("OUTPUT_SYNC_FAILED", "/output"));
  if (
    applied.uid !== existing.uid ||
    applied.gid !== existing.gid ||
    (applied.mode & 0o0777) !== (existing.mode & 0o0777)
  )
    ioFail("OUTPUT_SYNC_FAILED", "/output");
};

const writeAtomic = async (path, value, input) => {
  const absolute = resolve(path);
  if (absolute === input.absolute) ioFail("OUTPUT_ALIAS_INPUT", "/output");
  const parent = dirname(absolute);
  let parentStatus;
  try {
    parentStatus = await lstat(parent);
    if (
      parentStatus.isSymbolicLink() ||
      !parentStatus.isDirectory() ||
      (await realpath(parent)) !== parent
    )
      ioFail("OUTPUT_PARENT_INVALID", "/output");
  } catch (error) {
    if (error instanceof WorkflowSpecIoError) throw error;
    ioFail("OUTPUT_PARENT_INVALID", "/output");
  }
  let existing;
  try {
    existing = await statusOrNull(absolute);
  } catch {
    ioFail("OUTPUT_NOT_REGULAR", "/output");
  }
  if (existing?.isSymbolicLink()) ioFail("OUTPUT_SYMLINK", "/output");
  if (existing !== null && !existing.isFile())
    ioFail("OUTPUT_NOT_REGULAR", "/output");
  if (existing !== null && (existing.mode & 0o077) !== 0)
    ioFail("OUTPUT_ACL_UNSAFE", "/output");
  if (sameIdentity(existing, input.status))
    ioFail("OUTPUT_ALIAS_INPUT", "/output");
  const outputMode = existing === null ? await inheritedFileMode(parent) : null;
  let existingHandle;
  if (existing !== null) {
    try {
      existingHandle = await open(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const openedExisting = await existingHandle.stat();
      if (!openedExisting.isFile() || !sameIdentity(existing, openedExisting))
        ioFail("OUTPUT_CHANGED", "/output");
    } catch (error) {
      if (error instanceof WorkflowSpecIoError) throw error;
      ioFail("OUTPUT_CHANGED", "/output");
    }
  }
  const temporary = resolve(
    parent,
    temporaryName("tmp"),
  );
  let handle;
  let committed = false;
  try {
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch {
      ioFail("OUTPUT_TEMP_CREATE_FAILED", "/output");
    }
    try {
      await handle.writeFile(value, "utf8");
    } catch {
      ioFail("OUTPUT_WRITE_FAILED", "/output");
    }
    try {
      await handle.sync();
      if (existing === null) await handle.chmod(outputMode);
      else await preserveExistingMetadata(handle, existing);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch {
      ioFail("OUTPUT_SYNC_FAILED", "/output");
    }
    const current = await statusOrNull(absolute).catch(() =>
      ioFail("OUTPUT_CHANGED", "/output"),
    );
    if (
      (existing === null) !== (current === null) ||
      (existing !== null && !sameIdentity(existing, current))
    )
      ioFail("OUTPUT_CHANGED", "/output");
    try {
      await rename(temporary, absolute);
      committed = true;
    } catch {
      ioFail("OUTPUT_RENAME_FAILED", "/output");
    }
    let parentHandle;
    try {
      parentHandle = await open(parent, constants.O_RDONLY);
      await parentHandle.sync();
    } catch {
      ioFail("OUTPUT_SYNC_FAILED", "/output");
    } finally {
      await parentHandle?.close().catch(() => undefined);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await existingHandle?.close().catch(() => undefined);
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const main = async () => {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "validate" && command !== "canonicalize")
    ioFail("USAGE_ERROR", "");
  if (
    (command === "validate" && arguments_.length !== 1) ||
    (command === "canonicalize" && arguments_.length !== 2)
  )
    ioFail("USAGE_ERROR", "");
  const input = await readSafeFile(arguments_[0]);
  const value = parseWorkflowSpec(input.text);
  if (command === "canonicalize")
    await writeAtomic(arguments_[1], canonicalizeWorkflowSpec(value), input);
  process.stdout.write(`${JSON.stringify({ status: "PASS" })}\n`);
};

main().catch((error) => {
  const known =
    error instanceof WorkflowSpecError || error instanceof WorkflowSpecIoError;
  const code = known ? error.code : "INPUT_READ_FAILED";
  const path = known ? error.path : "/input";
  process.stderr.write(`${JSON.stringify({ status: "FAIL", code, path })}\n`);
  process.exitCode = error instanceof WorkflowSpecError ? 1 : 2;
});
