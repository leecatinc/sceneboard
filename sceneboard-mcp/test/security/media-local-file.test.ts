import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  captureLocalMediaFileV1,
  LOCAL_MEDIA_MAX_BYTES_V1,
} from '../../src/media/local-media-file.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

test('captures one exact regular image buffer and explicitly zeros released ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-media-'));
  const path = join(root, 'image.png');
  await writeFile(path, png);
  const result = await captureLocalMediaFileV1(path);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.mime, 'image/png');
  assert.equal(result.value.bytes.equals(png), true);
  assert.match(result.value.sha256, /^[0-9a-f]{64}$/u);
  const retained = result.value.bytes;
  result.value.release();
  assert.equal(
    retained.every((byte) => byte === 0),
    true,
  );
});

test('rejects lexical ambiguity, non-files, links, empty, oversize, and unsupported magic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-media-'));
  const regular = join(root, 'regular.png');
  await writeFile(regular, png);
  const link = join(root, 'link.png');
  await symlink(regular, link);
  const directory = join(root, 'directory');
  await mkdir(directory);
  const empty = join(root, 'empty.png');
  await writeFile(empty, Buffer.alloc(0));
  const unsupported = join(root, 'image.gif');
  await writeFile(unsupported, Buffer.from('GIF89a'));
  const oversized = join(root, 'large.png');
  await writeFile(oversized, png);
  await truncate(oversized, LOCAL_MEDIA_MAX_BYTES_V1 + 1);

  assert.deepEqual(await captureLocalMediaFileV1('relative.png'), {
    ok: false,
    code: 'INPUT_INVALID',
  });
  assert.deepEqual(
    await captureLocalMediaFileV1(`${root}/../${root.split('/').at(-1)}/regular.png`),
    {
      ok: false,
      code: 'INPUT_INVALID',
    },
  );
  assert.deepEqual(await captureLocalMediaFileV1(join(root, '*.png')), {
    ok: false,
    code: 'INPUT_INVALID',
  });
  for (const path of [link, directory, empty])
    assert.deepEqual(await captureLocalMediaFileV1(path), {
      ok: false,
      code: 'LOCAL_FILE_CHANGED',
    });
  assert.deepEqual(await captureLocalMediaFileV1(unsupported), {
    ok: false,
    code: 'LOCAL_MEDIA_UNSUPPORTED',
  });
  assert.deepEqual(await captureLocalMediaFileV1(oversized), {
    ok: false,
    code: 'LOCAL_FILE_TOO_LARGE',
  });
});
