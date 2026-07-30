import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const manifestUrl = new URL('../native/local-export-helper.manifest.json', import.meta.url);
const manifestStatus = await lstat(manifestUrl);
if (
  !manifestStatus.isFile() ||
  manifestStatus.isSymbolicLink() ||
  manifestStatus.uid !== process.geteuid?.()
)
  throw new Error('local export helper manifest is invalid');
const parsed = JSON.parse(await readFile(manifestUrl, 'utf8'));
if (
  parsed?.version !== 1 ||
  Object.keys(parsed.targets ?? {}).join('\0') !== 'linux-x64-gnu' ||
  Object.keys(parsed.targets['linux-x64-gnu'] ?? {})
    .sort()
    .join('\0') !== ['mode', 'path', 'sha256'].join('\0')
)
  throw new Error('local export helper manifest schema is invalid');
const selected = parsed.targets['linux-x64-gnu'];
if (
  selected.path !== 'linux-x64-gnu/local-export-helper' ||
  selected.mode !== '0500' ||
  !/^[a-f0-9]{64}$/.test(selected.sha256)
)
  throw new Error('local export helper target is invalid');
const helperUrl = new URL(selected.path, manifestUrl);
const digestUrl = new URL('linux-x64-gnu/local-export-helper.sha256', manifestUrl);
const [helperStatus, digestStatus, helperBytes, digestText] = await Promise.all([
  lstat(helperUrl),
  lstat(digestUrl),
  readFile(helperUrl),
  readFile(digestUrl, 'utf8'),
]);
if (
  !helperStatus.isFile() ||
  helperStatus.isSymbolicLink() ||
  (helperStatus.mode & 0o777) !== 0o500 ||
  helperStatus.uid !== process.geteuid?.() ||
  !digestStatus.isFile() ||
  digestStatus.isSymbolicLink() ||
  digestStatus.uid !== process.geteuid?.()
)
  throw new Error('local export helper permissions are invalid');
const actual = createHash('sha256').update(helperBytes).digest('hex');
if (actual !== selected.sha256 || digestText !== `${actual}\n`)
  throw new Error('local export helper integrity check failed');
console.log(JSON.stringify({ status: 'PASS', target: 'linux-x64-gnu', sha256: actual }));
