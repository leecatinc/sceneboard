import { createHash } from 'node:crypto';

import {
  ArtifactManifestParserV1,
  BOARD_LIMITS_V1,
  type ArtifactManifestV1,
  type ArtifactReferenceV1,
  type ArtifactResourceV1,
} from '@leecat-board/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import type { SanitizedArtifactSourceV1 } from './artifact-sanitizer.js';

export type PreparedArtifactResourceV1 = ArtifactResourceV1 & { bytes: Buffer };

export type PreparedArtifactPublicationV1 = {
  manifest: ArtifactManifestV1;
  manifestBytes: Buffer;
  manifestSha256: Buffer;
  resources: readonly PreparedArtifactResourceV1[];
  packageBytes: Buffer;
  sanitizerPolicyVersion: 1;
};

const digestHex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const resource = (path: string, mediaType: string, source: string): PreparedArtifactResourceV1 => {
  const bytes = Buffer.from(source, 'utf8');
  if (bytes.byteLength > BOARD_LIMITS_V1.maxArtifactResourceBytes) {
    throw new BoardContractError({
      protocolVersion: 1,
      type: 'board.error',
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Payload is too large',
      category: 'validation',
      retryable: false,
      httpStatusHint: 413,
      details: {
        scope: 'artifact.resource',
        actualBytes: bytes.byteLength,
        maximumBytes: BOARD_LIMITS_V1.maxArtifactResourceBytes,
      },
    });
  }
  return { path, mediaType, sha256: digestHex(bytes), byteLength: bytes.byteLength, bytes };
};

export const encodeArtifactPackageV1 = (
  manifestBytes: Buffer,
  resources: readonly PreparedArtifactResourceV1[],
): Buffer => {
  let total = 8 + 4 + manifestBytes.byteLength + 2;
  const paths = resources.map((item) => Buffer.from(item.path, 'utf8'));
  for (let index = 0; index < resources.length; index += 1) {
    total += 2 + (paths[index]?.byteLength ?? 0) + 4 + (resources[index]?.bytes.byteLength ?? 0);
  }
  const output = Buffer.allocUnsafe(total);
  let offset = 0;
  output.write('LCARTV1\0', offset, 8, 'ascii');
  offset += 8;
  output.writeUInt32BE(manifestBytes.byteLength, offset);
  offset += 4;
  manifestBytes.copy(output, offset);
  offset += manifestBytes.byteLength;
  output.writeUInt16BE(resources.length, offset);
  offset += 2;
  for (let index = 0; index < resources.length; index += 1) {
    const item = resources[index];
    const path = paths[index];
    if (item === undefined || path === undefined || path.byteLength > 65_535) throw new RangeError('artifact package path');
    output.writeUInt16BE(path.byteLength, offset);
    offset += 2;
    path.copy(output, offset);
    offset += path.byteLength;
    output.writeUInt32BE(item.bytes.byteLength, offset);
    offset += 4;
    item.bytes.copy(output, offset);
    offset += item.bytes.byteLength;
  }
  if (offset !== total) throw new RangeError('artifact package length');
  return output;
};

export class ArtifactPackageBuilderV1 {
  build(input: {
    artifact: ArtifactReferenceV1;
    requestedCapabilities: ArtifactManifestV1['requestedCapabilities'];
    source: SanitizedArtifactSourceV1;
  }): PreparedArtifactPublicationV1 {
    const resources = [
      resource('index.html', 'text/html', input.source.html),
      ...(input.source.css === null ? [] : [resource('styles.css', 'text/css', input.source.css)]),
      ...(input.source.javascript === null ? [] : [resource('main.js', 'text/javascript', input.source.javascript)]),
    ];
    const totalBytes = resources.reduce((total, item) => total + item.byteLength, 0);
    if (totalBytes > BOARD_LIMITS_V1.maxArtifactTotalBytes) {
      throw new BoardContractError({
        protocolVersion: 1,
        type: 'board.error',
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Payload is too large',
        category: 'validation',
        retryable: false,
        httpStatusHint: 413,
        details: {
          scope: 'artifact.total',
          actualBytes: totalBytes,
          maximumBytes: BOARD_LIMITS_V1.maxArtifactTotalBytes,
        },
      });
    }
    const parsed = ArtifactManifestParserV1.parse({
      protocolVersion: 1,
      type: 'artifact.manifest',
      artifact: input.artifact,
      entryPath: 'index.html',
      resources: resources.map(({ bytes: _bytes, ...descriptor }) => descriptor),
      requestedCapabilities: input.requestedCapabilities,
    });
    if (!parsed.ok) throw new BoardContractError(parsed.error);
    const manifestBytes = Buffer.from(parsed.data.canonicalBytes);
    return {
      manifest: parsed.data.value,
      manifestBytes,
      manifestSha256: createHash('sha256').update(manifestBytes).digest(),
      resources,
      packageBytes: encodeArtifactPackageV1(manifestBytes, resources),
      sanitizerPolicyVersion: input.source.sanitizerPolicyVersion,
    };
  }
}
