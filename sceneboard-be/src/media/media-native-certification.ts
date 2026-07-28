import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import sharp from 'sharp';

import type { MediaWriterExpectedDigestsV1 } from './media-writer-gate.js';

export type MediaNativeCertificationEvidenceV1 = Readonly<{
  ready: true;
  sharpVersion: string;
  libvipsVersion: string;
  artifactDigests: MediaWriterExpectedDigestsV1;
}>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const loadMediaNativeCertificationEvidence =
  (): MediaNativeCertificationEvidenceV1 | null => {
    try {
      const certificateBytes = readFileSync(
        new URL('../../../test/certification/media-native-certification.v1.json', import.meta.url),
      );
      const manifestBytes = readFileSync(
        new URL('../../../test/certification/fixtures/media/manifest.v1.json', import.meta.url),
      );
      const certificate: unknown = JSON.parse(certificateBytes.toString('utf8'));
      if (!isRecord(certificate) || !isRecord(certificate.artifactDigests)) return null;
      const migration = certificate.artifactDigests.migration;
      const projection = certificate.artifactDigests.projection;
      const nativeManifest = certificate.artifactDigests.nativeManifest;
      if (
        certificate.schemaVersion !== 1 ||
        certificate.verdict !== 'PASS' ||
        certificate.sharpVersion !== sharp.versions.sharp ||
        certificate.libvipsVersion !== sharp.versions.vips ||
        typeof migration !== 'string' ||
        typeof projection !== 'string' ||
        typeof nativeManifest !== 'string' ||
        !SHA256_PATTERN.test(migration) ||
        !SHA256_PATTERN.test(projection) ||
        !SHA256_PATTERN.test(nativeManifest) ||
        createHash('sha256').update(manifestBytes).digest('hex') !== nativeManifest
      )
        return null;
      return Object.freeze({
        ready: true,
        sharpVersion: sharp.versions.sharp,
        libvipsVersion: sharp.versions.vips,
        artifactDigests: Object.freeze({ migration, projection, nativeManifest }),
      });
    } catch {
      return null;
    }
  };
