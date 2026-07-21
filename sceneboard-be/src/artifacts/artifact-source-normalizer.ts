import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import type { BoardArtifactPutSourceV1 } from './artifact-http.dto.js';
import {
  ArtifactPackageBuilderV1,
  type PreparedArtifactPublicationV1,
} from './artifact-package.builder.js';
import { deriveArtifactPublicationIdsV1 } from './artifact-publication-ids.js';
import { ArtifactSanitizerV1 } from './artifact-sanitizer.js';

export class ArtifactSourceNormalizerV1 {
  constructor(
    private readonly sanitizer = new ArtifactSanitizerV1(),
    private readonly packages = new ArtifactPackageBuilderV1(),
  ) {}

  normalize(input: {
    principal: ResolvedBoardPrincipalV1;
    source: BoardArtifactPutSourceV1;
  }): PreparedArtifactPublicationV1 {
    const ids = deriveArtifactPublicationIdsV1({
      principal: input.principal,
      boardId: input.source.boardId,
      idempotencyKey: input.source.idempotencyKey,
      artifactId: input.source.artifactId,
    });
    const source = this.sanitizer.sanitize(input.source);
    return this.packages.build({
      artifact: ids,
      requestedCapabilities: [...input.source.requestedCapabilities],
      source,
    });
  }
}
