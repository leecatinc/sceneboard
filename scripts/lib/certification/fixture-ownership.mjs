import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CertificationError } from './canonical-json.mjs';

export const GENERATED_PARENT_PATHS = ['.artifacts/certification', '.certification-fixtures'];

const safeSegment = (value, name) => {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new CertificationError(
      'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION',
      `${name} is not a safe path segment`,
    );
  }
  return value;
};

export const resolveOwnedChild = (parent, ...segments) => {
  if (!isAbsolute(parent)) throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
  const child = resolve(
    parent,
    ...segments.map((segment, index) => safeSegment(segment, `segment-${index}`)),
  );
  const offset = relative(parent, child);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
  }
  return child;
};

export const assertOwnedDirectory = async (path) => {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
  }
  if ((await realpath(path)) !== path)
    throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
};

export const ensureOwnedParent = async (workspaceRoot, relativePath) => {
  if (!GENERATED_PARENT_PATHS.includes(relativePath)) {
    throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
  }
  const parent = resolve(workspaceRoot, relativePath);
  const offset = relative(workspaceRoot, parent);
  if (offset !== relativePath.split('/').join(sep))
    throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(parent);
  return parent;
};

export const claimFreshDirectory = async (parent, ...segments) => {
  const child = resolveOwnedChild(parent, ...segments);
  try {
    await mkdir(child, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new CertificationError('SOURCE_TREE_DIRTY_OR_UNATTESTED');
    throw error;
  }
  await assertOwnedDirectory(child);
  return child;
};

export const ensureOwnedChildDirectory = async (parent, ...segments) => {
  const child = resolveOwnedChild(parent, ...segments);
  await mkdir(child, { recursive: false, mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  await assertOwnedDirectory(child);
  return child;
};
