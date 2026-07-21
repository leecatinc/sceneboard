import {
  ArtifactManifestParserV1,
  BOARD_LIMITS_V1,
  canonicalizeJsonV1,
  type ArtifactManifestV1,
  type ArtifactResourceV1,
} from '@sceneboard/board-schema';

const MAGIC = new Uint8Array([76, 67, 65, 82, 84, 86, 49, 0]);
const MAX_FRAMING_BYTES = 262_144;

export type DecodedArtifactResourceV1 = ArtifactResourceV1 & { bytes: Uint8Array };
export type DecodedArtifactPackageV1 = {
  manifest: ArtifactManifestV1;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  packageSha256: string;
  resources: readonly DecodedArtifactResourceV1[];
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

export const sha256HexV1 = async (bytes: Uint8Array): Promise<string> => {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input.buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
};

const asBytes = (input: ArrayBuffer | Uint8Array): Uint8Array =>
  input instanceof Uint8Array ? input : new Uint8Array(input);

export const decodeArtifactPackageV1 = async (
  input: ArrayBuffer | Uint8Array,
): Promise<DecodedArtifactPackageV1> => {
  const bytes = asBytes(input);
  if (
    bytes.byteLength < 14 ||
    bytes.byteLength > BOARD_LIMITS_V1.maxArtifactTotalBytes + MAX_FRAMING_BYTES ||
    !equalBytes(bytes.subarray(0, 8), MAGIC)
  ) {
    throw new TypeError('artifact package framing is invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  const take = (length: number): Uint8Array => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.byteLength) {
      throw new TypeError('artifact package is truncated');
    }
    const result = bytes.subarray(offset, offset + length);
    offset += length;
    return result;
  };
  const uint16 = (): number => {
    if (offset + 2 > bytes.byteLength) throw new TypeError('artifact package is truncated');
    const value = view.getUint16(offset, false);
    offset += 2;
    return value;
  };
  const uint32 = (): number => {
    if (offset + 4 > bytes.byteLength) throw new TypeError('artifact package is truncated');
    const value = view.getUint32(offset, false);
    offset += 4;
    return value;
  };
  const manifestLength = uint32();
  if (manifestLength === 0 || manifestLength > MAX_FRAMING_BYTES)
    throw new TypeError('artifact manifest length is invalid');
  const manifestBytes = take(manifestLength);
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new TypeError('artifact manifest UTF-8 JSON is invalid');
  }
  const manifest = ArtifactManifestParserV1.parse(manifestJson);
  if (!manifest.ok || !equalBytes(manifest.data.canonicalBytes, manifestBytes)) {
    throw new TypeError('artifact manifest is not canonical');
  }
  const canonical = canonicalizeJsonV1(manifest.data.value);
  if (!canonical.ok || !equalBytes(canonical.data.canonicalBytes, manifestBytes)) {
    throw new TypeError('artifact manifest canonicalizer disagreement');
  }
  const resourceCount = uint16();
  if (resourceCount !== manifest.data.value.resources.length)
    throw new TypeError('artifact resource count mismatch');
  const resources: DecodedArtifactResourceV1[] = [];
  const seen = new Set<string>();
  let resourceBytes = 0;
  for (let index = 0; index < resourceCount; index += 1) {
    const descriptor = manifest.data.value.resources[index];
    if (descriptor === undefined) throw new TypeError('artifact resource descriptor is missing');
    const pathLength = uint16();
    if (pathLength === 0) throw new TypeError('artifact resource path is empty');
    let path: string;
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(take(pathLength));
    } catch {
      throw new TypeError('artifact resource path UTF-8 is invalid');
    }
    const byteLength = uint32();
    const resource = take(byteLength);
    resourceBytes += resource.byteLength;
    if (
      resourceBytes > BOARD_LIMITS_V1.maxArtifactTotalBytes ||
      seen.has(path) ||
      path !== descriptor.path ||
      byteLength !== descriptor.byteLength ||
      (await sha256HexV1(resource)) !== descriptor.sha256
    ) {
      throw new TypeError('artifact resource certification failed');
    }
    seen.add(path);
    resources.push({ ...descriptor, bytes: resource });
  }
  if (offset !== bytes.byteLength) throw new TypeError('artifact package has trailing bytes');
  return {
    manifest: manifest.data.value,
    manifestBytes,
    manifestSha256: await sha256HexV1(manifestBytes),
    packageSha256: await sha256HexV1(bytes),
    resources,
  };
};
