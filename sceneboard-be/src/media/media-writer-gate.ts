import { BoardContractError } from '../common/errors/app-error.js';
import { invalidMediaReference } from '../common/errors/board-error.factory.js';
import type { MediaWriterCertificationV1 } from '../bootstrap/persistence-certification.types.js';
import { mediaServiceUnavailable } from './media-errors.js';

export const MEDIA_WRITER_GATE = Symbol('MEDIA_WRITER_GATE');

export type MediaWriterExpectedDigestsV1 = MediaWriterCertificationV1['artifactDigests'];

export class MediaWriterGate {
  private certification: MediaWriterCertificationV1 | null = null;

  constructor(
    private readonly bootedAt: string,
    private readonly expectedDigests: MediaWriterExpectedDigestsV1,
  ) {}

  enable(certificate: MediaWriterCertificationV1): boolean {
    const exactDigests =
      certificate.artifactDigests.migration === this.expectedDigests.migration &&
      certificate.artifactDigests.projection === this.expectedDigests.projection &&
      certificate.artifactDigests.nativeManifest === this.expectedDigests.nativeManifest;
    const currentBoot = certificate.checkedAt >= this.bootedAt;
    if (
      !certificate.revisionMediaRefsReady ||
      !certificate.mediaStoreProjectionReady ||
      !certificate.mediaNativeDecoderReady ||
      !exactDigests ||
      !currentBoot
    ) {
      this.certification = null;
      return false;
    }
    this.certification = Object.freeze(certificate);
    return true;
  }

  disable(): void {
    this.certification = null;
  }

  isReady(): boolean {
    return this.certification !== null;
  }

  assertUploadReady(): void {
    if (!this.isReady()) throw new BoardContractError(mediaServiceUnavailable());
  }

  assertMutationReady(): void {
    if (!this.isReady()) throw new BoardContractError(invalidMediaReference());
  }
}
