import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const helper = new URL('../native/profile-lease-helper', import.meta.url);
const digestFile = new URL('../native/profile-lease-helper.sha256', import.meta.url);
const [status, digestStatus] = await Promise.all([lstat(helper), lstat(digestFile)]);
if (
  !status.isFile() ||
  status.isSymbolicLink() ||
  (status.mode & 0o777) !== 0o500 ||
  status.uid !== process.geteuid?.()
) {
  throw new Error('profile lease helper permissions are invalid');
}
if (
  !digestStatus.isFile() ||
  digestStatus.isSymbolicLink() ||
  digestStatus.uid !== process.geteuid?.()
)
  throw new Error('profile lease helper digest file is invalid');
const digest = createHash('sha256')
  .update(await readFile(helper))
  .digest('hex');
const expected = (await readFile(digestFile, 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(expected) || expected !== digest) {
  throw new Error('profile lease helper integrity check failed');
}
