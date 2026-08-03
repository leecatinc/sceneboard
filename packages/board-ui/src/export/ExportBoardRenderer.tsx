'use client';

import type { ArtifactRuntimeSummaryV1, TimestampV1 } from '@sceneboard/board-schema';
import { useEffect, useMemo, useState } from 'react';
import { BoardRenderer } from '../renderer/BoardRenderer.js';
import type { PageRendererContextV2, RendererComponentV1 } from '../renderer/renderer-types.js';
import { ExportArtifactHost, ExportArtifactPackageStoreV1 } from './ExportArtifactHost.js';
import { createExportMediaResolverV1, ExportMediaStoreV1 } from './export-media-resolver.js';
import type { ExportProjectionV1 } from './export-types.js';

const artifactRuntimes = (projection: ExportProjectionV1): ArtifactRuntimeSummaryV1[] =>
  projection.resources.flatMap((resource) =>
    resource.usage.kind === 'artifact'
      ? [
          {
            artifact: {
              artifactId: resource.usage.artifactId,
              versionId: resource.usage.versionId,
            },
            status: 'ready' as const,
            updatedAt: '1970-01-01T00:00:00.000Z' as TimestampV1,
            failure: null,
          },
        ]
      : [],
  );

export function ExportBoardRenderer({
  projection,
  pageIndex,
  runtimeOrigin,
}: {
  projection: ExportProjectionV1;
  pageIndex: number;
  runtimeOrigin: string;
}) {
  const packageStore = useMemo(() => new ExportArtifactPackageStoreV1(projection), [projection]);
  const mediaStore = useMemo(() => new ExportMediaStoreV1(projection), [projection]);
  const [packageStatus, setPackageStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [mediaStatus, setMediaStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const fontResources = useMemo(
    () =>
      projection.resources.filter(
        (resource) => resource.usage.kind === 'font' && resource.mediaType === 'font/woff2',
      ),
    [projection],
  );
  const [fontStatus, setFontStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let active = true;
    setPackageStatus('loading');
    void packageStore.prepareAll().then(
      () => active && setPackageStatus('ready'),
      () => active && setPackageStatus('failed'),
    );
    return () => {
      active = false;
      packageStore.dispose();
    };
  }, [packageStore]);
  useEffect(() => {
    let active = true;
    setMediaStatus('loading');
    void mediaStore.prepareAll().then(
      () => active && setMediaStatus('ready'),
      () => active && setMediaStatus('failed'),
    );
    return () => {
      active = false;
      mediaStore.dispose();
    };
  }, [mediaStore]);
  useEffect(() => {
    let active = true;
    const faces: FontFace[] = [];
    setFontStatus('loading');
    const korean = fontResources.find(
      (resource) => resource.usage.kind === 'font' && resource.usage.subset === 'korean',
    );
    const latin = fontResources.find(
      (resource) => resource.usage.kind === 'font' && resource.usage.subset === 'latin',
    );
    if (korean === undefined || latin === undefined || fontResources.length !== 2) {
      setFontStatus('failed');
      return () => {
        active = false;
      };
    }
    const load = async (): Promise<void> => {
      const definitions = [
        [
          korean,
          'U+1100-11FF,U+3130-318F,U+A960-A97F,U+AC00-D7AF,U+D7B0-D7FF,U+3000-303F,U+FF00-FFEF',
        ],
        [latin, 'U+0000-024F,U+1E00-1EFF,U+2000-206F'],
      ] as const;
      for (const [resource, unicodeRange] of definitions) {
        const face = new FontFace('Noto Sans KR', `url("${resource.url}") format("woff2")`, {
          display: 'block',
          style: 'normal',
          weight: '400',
          unicodeRange,
        });
        faces.push(face);
        await face.load();
        document.fonts.add(face);
      }
      if (
        faces.some((face) => face.status !== 'loaded') ||
        !document.fonts.check('400 16px "Noto Sans KR"', 'SceneBoard') ||
        !document.fonts.check('400 16px "Noto Sans KR"', '한글')
      )
        throw new TypeError('locked export fonts are unavailable');
      if (active) setFontStatus('ready');
    };
    void load().catch(() => active && setFontStatus('failed'));
    return () => {
      active = false;
      for (const face of faces) document.fonts.delete(face);
    };
  }, [fontResources]);
  const page = projection.document.pages[pageIndex];
  if (page === undefined)
    return <section data-export-unsupported="page">Required page is unavailable.</section>;
  const artifacts = artifactRuntimes(projection);
  const context = {
    protocolVersion: 1,
    boardId: projection.boardId,
    revision: {
      revisionId: projection.revisionId,
      revisionNumber: projection.revisionNumber,
      createdAt: '1970-01-01T00:00:00.000Z',
      previousRevisionId: null,
      originType: 'system',
      sourceRevisionId: null,
      actor: {
        principalKind: 'service',
        principalId: 'export',
        grantId: null,
        scopes: [],
      },
    },
    hitl: [],
    artifacts,
    capabilities: {
      grantedCapabilities: [],
      deniedCapabilities: [],
      policyEpoch: 'AAAAAAAAAAAAAAAAAAAAAA',
    },
    lastEventSequence: 1,
    documentSchemaVersion: 3,
    selectedPageId: page.pageId,
  } as unknown as PageRendererContextV2;
  const renderArtifact: RendererComponentV1<'content.artifact'> = ({ node, context }) => (
    <ExportArtifactHost
      projection={projection}
      packageStore={packageStore}
      runtimeOrigin={runtimeOrigin}
      node={node}
      context={context}
    />
  );
  const renderHitl: RendererComponentV1<'content.hitl'> = () => (
    <section data-export-unsupported="hitl">Interactive content cannot be exported.</section>
  );
  return (
    <main
      data-export-page={pageIndex}
      data-export-fonts={fontStatus}
      {...(fontStatus === 'failed' || packageStatus === 'failed' || mediaStatus === 'failed'
        ? { 'data-export-unsupported': 'locked-resource' }
        : fontStatus === 'loading' || packageStatus === 'loading' || mediaStatus === 'loading'
          ? { 'data-export-pending': 'locked-resource' }
          : {})}
      style={{
        width: projection.format.css.width,
        height: projection.format.css.height,
        overflow: 'hidden',
      }}
    >
      <BoardRenderer
        page={page}
        context={context}
        renderArtifact={renderArtifact}
        renderHitl={renderHitl}
        mediaResolver={createExportMediaResolverV1(projection, packageStore, mediaStore)}
        emptyLabel=""
      />
    </main>
  );
}
