import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, normalize, parse, sep } from 'node:path';

import type { MediaMimeV1 } from '@sceneboard/board-schema';

export const LOCAL_MEDIA_MAX_BYTES_V1 = 10_485_760;

export type LocalMediaCaptureErrorCodeV1 =
  | 'INPUT_INVALID'
  | 'LOCAL_FILE_CHANGED'
  | 'LOCAL_FILE_PLATFORM_UNSUPPORTED'
  | 'LOCAL_FILE_TOO_LARGE'
  | 'LOCAL_MEDIA_UNSUPPORTED';

export type CapturedLocalMediaV1 = Readonly<{
  bytes: Buffer;
  mime: MediaMimeV1;
  sha256: string;
  digestBase64: string;
  release(): void;
}>;

export type LocalMediaCaptureResultV1 =
  | { ok: true; value: CapturedLocalMediaV1 }
  | { ok: false; code: LocalMediaCaptureErrorCodeV1 };

type Identity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

const identity = (stat: {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): Identity => ({
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
});

const sameIdentity = (left: Identity, right: Identity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const lexicalPathValid = (value: string): boolean =>
  value.length > 0 &&
  !value.includes('\0') &&
  !/[*?[\]{}!]/u.test(value) &&
  isAbsolute(value) &&
  value !== parse(value).root &&
  !value.endsWith(sep) &&
  normalize(value) === value;

const detectedMime = (bytes: Buffer): MediaMimeV1 | null => {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
};

const changed = (): LocalMediaCaptureResultV1 => ({ ok: false, code: 'LOCAL_FILE_CHANGED' });

export const captureLocalMediaFileV1 = async (path: string): Promise<LocalMediaCaptureResultV1> => {
  if (!lexicalPathValid(path)) return { ok: false, code: 'INPUT_INVALID' };
  if (
    process.platform === 'win32' ||
    typeof constants.O_NOFOLLOW !== 'number' ||
    typeof constants.O_NONBLOCK !== 'number'
  )
    return { ok: false, code: 'LOCAL_FILE_PLATFORM_UNSUPPORTED' };

  let handle: FileHandle | null = null;
  let bytes: Buffer | null = null;
  let retained = false;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return changed();
    if (before.size < 1n) return changed();
    if (before.size > BigInt(LOCAL_MEDIA_MAX_BYTES_V1))
      return { ok: false, code: 'LOCAL_FILE_TOO_LARGE' };
    const first = identity(before);
    const length = Number(before.size);
    bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = await handle.read(bytes, offset, length - offset, offset);
      if (read.bytesRead <= 0) return changed();
      offset += read.bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    try {
      const extra = await handle.read(probe, 0, 1, length);
      if (extra.bytesRead !== 0) return changed();
    } finally {
      probe.fill(0);
    }
    const mime = detectedMime(bytes);
    if (mime === null) return { ok: false, code: 'LOCAL_MEDIA_UNSUPPORTED' };
    const digest = createHash('sha256').update(bytes).digest();
    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      !afterDescriptor.isFile() ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      !sameIdentity(first, identity(afterDescriptor)) ||
      !sameIdentity(first, identity(afterPath))
    )
      return changed();
    retained = true;
    let released = false;
    const owned = bytes;
    return {
      ok: true,
      value: {
        bytes: owned,
        mime,
        sha256: digest.toString('hex'),
        digestBase64: digest.toString('base64'),
        release: () => {
          if (released) return;
          released = true;
          owned.fill(0);
        },
      },
    };
  } catch {
    return changed();
  } finally {
    await handle?.close().catch(() => undefined);
    if (!retained) bytes?.fill(0);
  }
};
