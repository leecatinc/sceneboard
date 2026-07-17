import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type { ArtifactRuntimeTopologyV1 } from '../topology/index.js';
import {
  assertRuntimeHeadersV1,
  buildFixedAssetHeadersV1,
  buildHealthHeadersV1,
  buildRunnerHeadersV1,
  type RuntimeHeadersV1,
} from './headers.js';

export type FixedAssetEntryV1 = {
  logicalName: 'outer' | 'mermaid';
  path: string;
  sha256: string;
  byteLength: number;
  mediaType: 'application/javascript; charset=utf-8';
};

export type ArtifactRuntimeAssetsV1 = {
  runnerHtml: Uint8Array;
  entries: ReadonlyMap<string, FixedAssetEntryV1 & { bytes: Uint8Array }>;
};

export type RuntimeRouteResponseV1 = {
  status: number;
  headers: RuntimeHeadersV1;
  body: Uint8Array;
};

const HASHED_ASSET = /^\/assets\/(outer|mermaid)\.([0-9a-f]{64})\.js$/u;
const MANIFEST_KEYS = ['logicalName', 'path', 'sha256', 'byteLength', 'mediaType'] as const;

const safeAssetPath = (publicDirectory: string, path: string): string => {
  if (!HASHED_ASSET.test(path)) throw new TypeError('fixed asset path is not content hashed');
  const absolute = resolve(publicDirectory, `.${path}`);
  if (!absolute.startsWith(`${resolve(publicDirectory)}${sep}`)) throw new TypeError('fixed asset path escapes public directory');
  return absolute;
};

export const loadArtifactRuntimeAssetsV1 = async (publicDirectory: string): Promise<ArtifactRuntimeAssetsV1> => {
  const [runnerHtml, manifestBytes] = await Promise.all([
    readFile(resolve(publicDirectory, 'runner.html')),
    readFile(resolve(publicDirectory, 'fixed-assets.v1.json')),
  ]);
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new TypeError('fixed asset manifest is invalid JSON');
  }
  if (!Array.isArray(input) || input.length !== 2) throw new TypeError('fixed asset manifest must contain outer and Mermaid');
  const entries = new Map<string, FixedAssetEntryV1 & { bytes: Uint8Array }>();
  let priorPath = '';
  for (const item of input) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('fixed asset manifest entry is invalid');
    const value = item as Record<string, unknown>;
    const keys = Object.keys(value);
    if (keys.length !== MANIFEST_KEYS.length || MANIFEST_KEYS.some((key) => !Object.hasOwn(value, key))
      || keys.some((key) => !MANIFEST_KEYS.includes(key as typeof MANIFEST_KEYS[number]))) throw new TypeError('fixed asset manifest entry keys are invalid');
    if ((value.logicalName !== 'outer' && value.logicalName !== 'mermaid')
      || typeof value.path !== 'string'
      || typeof value.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(value.sha256)
      || !Number.isSafeInteger(value.byteLength)
      || (value.byteLength as number) < 1
      || value.mediaType !== 'application/javascript; charset=utf-8'
      || value.path <= priorPath
      || entries.has(value.path)) throw new TypeError('fixed asset manifest entry is invalid or unsorted');
    const match = HASHED_ASSET.exec(value.path);
    if (match?.[1] !== value.logicalName || match[2] !== value.sha256) throw new TypeError('fixed asset path does not match its identity');
    const bytes = await readFile(safeAssetPath(publicDirectory, value.path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== value.byteLength || actual !== value.sha256) throw new TypeError('fixed asset digest or length mismatch');
    entries.set(value.path, { ...(value as FixedAssetEntryV1), bytes });
    priorPath = value.path;
  }
  if (![...entries.values()].some((entry) => entry.logicalName === 'outer')
    || ![...entries.values()].some((entry) => entry.logicalName === 'mermaid')) throw new TypeError('fixed asset manifest is incomplete');
  const runnerText = new TextDecoder('utf-8', { fatal: true }).decode(runnerHtml);
  const outer = [...entries.values()].find((entry) => entry.logicalName === 'outer');
  if (outer === undefined || !runnerText.includes(`<script src="${outer.path}"></script>`)) {
    throw new TypeError('runner HTML does not reference the certified outer asset');
  }
  return { runnerHtml, entries };
};

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const safeResponse = (status: number, headers: RuntimeHeadersV1, body: Uint8Array): RuntimeRouteResponseV1 => {
  assertRuntimeHeadersV1(headers);
  return { status, headers, body };
};

export const routeArtifactRuntimeRequestV1 = (input: {
  method: string;
  path: string;
  host: string | undefined;
  topology: ArtifactRuntimeTopologyV1;
  assets: ArtifactRuntimeAssetsV1;
}): RuntimeRouteResponseV1 => {
  if (input.host !== input.topology.expectedHost) {
    return safeResponse(421, buildHealthHeadersV1(), text('misdirected\n'));
  }
  if (input.method !== 'GET') {
    return safeResponse(405, Object.freeze({ ...buildHealthHeadersV1(), Allow: 'GET' }), text('method not allowed\n'));
  }
  if (input.path === '/healthz') return safeResponse(200, buildHealthHeadersV1(), text('ok\n'));
  if (input.path === '/runner') {
    return safeResponse(200, buildRunnerHeadersV1({ appOrigin: input.topology.frontendOrigin, runtimeOrigin: input.topology.runtimeOrigin }), input.assets.runnerHtml);
  }
  const asset = input.assets.entries.get(input.path);
  if (asset !== undefined) return safeResponse(200, buildFixedAssetHeadersV1(), asset.bytes);
  return safeResponse(404, buildHealthHeadersV1(), text('not found\n'));
};
