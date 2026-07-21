import { BOARD_LIMITS_V1, type ArtifactReferenceV1 } from '@sceneboard/board-schema';

import {
  BoardApiTransport,
  createPublicId,
  hasNoStore,
  operationRequest,
  parseArtifactReference,
  parseBoardId,
} from './board-api-core';
import type {
  ApiResult,
  ArtifactGetResult,
  ArtifactNetworkFetchInput,
  ArtifactNetworkResult,
  ArtifactPackageResult,
} from './board-api-types';

export class BoardArtifactApi extends BoardApiTransport {
  async getArtifact(
    boardIdValue: string,
    artifactValue: ArtifactReferenceV1,
    signal?: AbortSignal,
  ): Promise<ApiResult<ArtifactGetResult>> {
    const boardId = parseBoardId(boardIdValue);
    const artifact = parseArtifactReference(artifactValue);
    const request = operationRequest<'artifact.get'>({
      protocolVersion: 1,
      requestId: createPublicId('req'),
      type: 'artifact.get',
      boardId,
      artifact,
    });
    const query = new URLSearchParams({ requestId: request.requestId });
    return this.readOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}?${query.toString()}`,
      request,
      signal,
    );
  }

  async getArtifactPackage(
    boardIdValue: string,
    artifactValue: ArtifactReferenceV1,
    signal?: AbortSignal,
  ): Promise<ApiResult<ArtifactPackageResult>> {
    const boardId = parseBoardId(boardIdValue);
    const artifact = parseArtifactReference(artifactValue);
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/boards/${encodeURIComponent(boardId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}/package`,
      method: 'GET',
      responseKind: 'artifact-package',
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return result;
    const { response, bytes } = result.value;
    const vary =
      response.headers
        .get('vary')
        ?.split(',')
        .map((value) => value.trim().toLowerCase())
        .sort() ?? [];
    if (
      !response.ok ||
      response.redirected ||
      response.status !== 200 ||
      response.headers.get('content-type')?.toLowerCase() !==
        'application/vnd.leecat.artifact-package.v1' ||
      !hasNoStore(response.headers.get('cache-control')) ||
      JSON.stringify(vary) !== JSON.stringify(['authorization', 'cookie', 'origin']) ||
      response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff' ||
      response.headers.has('set-cookie') ||
      bytes.byteLength < 14 ||
      bytes.byteLength > BOARD_LIMITS_V1.maxArtifactTotalBytes + 262_144
    ) {
      return { kind: 'corrupt_response' };
    }
    return { kind: 'ok', value: { bytes } };
  }

  async requestArtifactNetworkFetch(
    input: ArtifactNetworkFetchInput,
  ): Promise<ApiResult<ArtifactNetworkResult>> {
    const boardId = parseBoardId(input.boardId);
    const artifact = parseArtifactReference(input.artifact);
    const requestId = createPublicId('req');
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/boards/${encodeURIComponent(boardId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}/capability-requests/network-fetch`,
      method: 'POST',
      csrfToken: input.csrfToken,
      body: {
        protocolVersion: 1,
        type: 'artifact.network.fetch.request',
        requestId,
        method: input.method,
        url: input.url,
      },
      responseKind: 'artifact-network',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.kind !== 'ok') return result;
    const { response, bytes } = result.value;
    if (
      !response.ok ||
      response.redirected ||
      response.status !== 200 ||
      response.headers.get('content-type')?.toLowerCase() !==
        'application/vnd.leecat.artifact-network-result.v1' ||
      !hasNoStore(response.headers.get('cache-control')) ||
      response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff' ||
      response.headers.has('set-cookie')
    )
      return { kind: 'corrupt_response' };
    return { kind: 'ok', value: { bytes } };
  }
}
