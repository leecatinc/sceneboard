import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { CertificationError, canonicalJson, sha256 } from './canonical-json.mjs';
import {
  claimFreshDirectory,
  ensureOwnedChildDirectory,
  ensureOwnedParent,
  resolveOwnedChild,
} from './fixture-ownership.mjs';

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const secretLikeKey =
  /(?:password|secret|token|credential|cookie|authorization|proof|otp|csrf|rawValue|bindValue|payloadBody)/iu;

const safeObject = (value, path = '') => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
      /\bsk-[A-Za-z0-9_-]{20,}\b/u.test(value)
    ) {
      throw new CertificationError('EVIDENCE_SECRET_CANARY_MATCH', path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => safeObject(entry, `${path}/${index}`));
    return;
  }
  if (typeof value !== 'object') throw new CertificationError('EVIDENCE_SCHEMA_INVALID');
  for (const [key, nested] of Object.entries(value)) {
    if (secretLikeKey.test(key) && !/(?:Sha256|Hash|Digest)$/u.test(key)) {
      throw new CertificationError('EVIDENCE_SECRET_FIELD_FORBIDDEN', `${path}/${key}`);
    }
    safeObject(nested, `${path}/${key}`);
  }
};

const exclusiveJson = async (path, value, maxBytes = MAX_RECORD_BYTES) => {
  safeObject(value);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  if (bytes.length > maxBytes) throw new CertificationError('EVIDENCE_RECORD_TOO_LARGE');
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
    throw error;
  }
  return sha256(bytes);
};

export class CertificationEvidenceWriter {
  static async create({ workspaceRoot, sourceCommit, manifestSha256, profile, attemptId }) {
    const parent = await ensureOwnedParent(workspaceRoot, '.artifacts/certification');
    const sourceRoot = await ensureOwnedChildDirectory(parent, sourceCommit);
    const manifestRoot = await ensureOwnedChildDirectory(sourceRoot, manifestSha256);
    const profileRoot = await ensureOwnedChildDirectory(manifestRoot, profile);
    const attemptRoot = await claimFreshDirectory(profileRoot, attemptId);
    const ownerToken = randomBytes(32).toString('hex');
    await exclusiveJson(resolve(attemptRoot, '.owner.json'), {
      schemaVersion: 1,
      ownerClass: 'D9-certification-evidence',
      ownerTokenSha256: sha256(ownerToken),
    });
    await mkdir(resolve(attemptRoot, 'records'), { mode: 0o700 });
    await mkdir(resolve(attemptRoot, 'attachments'), { mode: 0o700 });
    await mkdir(resolve(attemptRoot, 'phases'), { mode: 0o700 });
    await mkdir(resolve(attemptRoot, 'exclusions'), { mode: 0o700 });
    return new CertificationEvidenceWriter({ attemptRoot, ownerToken, attemptId });
  }

  constructor({ attemptRoot, ownerToken, attemptId }) {
    this.attemptRoot = attemptRoot;
    this.ownerToken = ownerToken;
    this.attemptId = attemptId;
  }

  #assertToken(ownerToken) {
    if (ownerToken !== this.ownerToken)
      throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
  }

  async writeRecord(ownerToken, row) {
    this.#assertToken(ownerToken);
    if (!/^[A-Z0-9][A-Z0-9._-]{0,127}$/u.test(row?.rowId ?? ''))
      throw new CertificationError('EVIDENCE_SCHEMA_INVALID');
    return exclusiveJson(
      resolveOwnedChild(resolve(this.attemptRoot, 'records'), `${row.rowId}.json`),
      row,
    );
  }

  async writeAttachment(ownerToken, bytes, mediaType) {
    this.#assertToken(ownerToken);
    const value = Buffer.from(bytes);
    if (value.length > MAX_ATTACHMENT_BYTES)
      throw new CertificationError('EVIDENCE_ATTACHMENT_TOO_LARGE');
    if (/^(?:text\/|application\/(?:json|xml))/u.test(mediaType))
      safeObject(value.toString('utf8'), 'attachment');
    const contentSha256 = sha256(value);
    const path = resolveOwnedChild(
      resolve(this.attemptRoot, 'attachments'),
      `${contentSha256}.bin`,
    );
    try {
      await writeFile(path, value, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await exclusiveJson(
      resolveOwnedChild(resolve(this.attemptRoot, 'attachments'), `${contentSha256}.json`),
      {
        schemaVersion: 1,
        contentSha256,
        byteLength: value.length,
        mediaType,
      },
    ).catch((error) => {
      if (error.code !== 'EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION') throw error;
    });
    return { contentSha256, byteLength: value.length, mediaType };
  }

  async writeFirstFailure(ownerToken, failure) {
    this.#assertToken(ownerToken);
    return exclusiveJson(resolve(this.attemptRoot, 'first-failure.json'), failure);
  }

  async writeRunExclusion(ownerToken, exclusion) {
    this.#assertToken(ownerToken);
    if (
      exclusion?.schemaVersion !== 1 ||
      exclusion?.status !== 'excluded-by-user-current-run' ||
      exclusion?.decisionId !== 'AMD-06' ||
      exclusion?.attemptId !== this.attemptId
    )
      throw new CertificationError('EVIDENCE_EXCLUSION_INVALID');
    const path = resolveOwnedChild(resolve(this.attemptRoot, 'exclusions'), 'AMD-06.json');
    const recordSha256 = await exclusiveJson(path, exclusion);
    return { path: 'exclusions/AMD-06.json', recordSha256 };
  }

  async finalizePhase(ownerToken, phaseId, index) {
    this.#assertToken(ownerToken);
    const temporary = resolveOwnedChild(resolve(this.attemptRoot, 'phases'), `${phaseId}.tmp`);
    const final = resolveOwnedChild(resolve(this.attemptRoot, 'phases'), `${phaseId}.json`);
    await exclusiveJson(temporary, index);
    try {
      await rename(temporary, final);
    } catch {
      throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
    }
    return sha256(await readFile(final));
  }

  async evidenceTreeSha256() {
    const rows = [];
    const visit = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
        if (entry.isDirectory()) await visit(path);
        else if (
          entry.isFile() &&
          entry.name !== 'release-index.json' &&
          entry.name !== '.owner.json'
        ) {
          rows.push({
            path: relative(this.attemptRoot, path).split('\\').join('/'),
            sha256: sha256(await readFile(path)),
          });
        }
      }
    };
    await visit(this.attemptRoot);
    rows.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    return sha256(canonicalJson(rows));
  }

  async finalizeRelease(ownerToken, index) {
    this.#assertToken(ownerToken);
    if (existsSync(resolve(this.attemptRoot, 'release-index.json')))
      throw new CertificationError('EVIDENCE_OUTPUT_OWNERSHIP_VIOLATION');
    const exclusions = await readdir(resolve(this.attemptRoot, 'exclusions'));
    if (exclusions.length > 0) {
      if (
        exclusions.length !== 1 ||
        exclusions[0] !== 'AMD-06.json' ||
        index?.runExclusion?.path !== 'exclusions/AMD-06.json'
      )
        throw new CertificationError('EVIDENCE_EXCLUSION_HASH_MISSING');
      const exclusionBytes = await readFile(
        resolveOwnedChild(resolve(this.attemptRoot, 'exclusions'), 'AMD-06.json'),
      );
      if (index.runExclusion.recordSha256 !== sha256(exclusionBytes))
        throw new CertificationError('EVIDENCE_EXCLUSION_HASH_MISSING');
    }
    const evidenceTreeSha256 = await this.evidenceTreeSha256();
    const release = { ...index, evidenceTreeSha256 };
    const releaseIndexSha256 = await exclusiveJson(
      resolve(this.attemptRoot, 'release-index.json'),
      release,
    );
    return { evidenceTreeSha256, releaseIndexSha256 };
  }
}
