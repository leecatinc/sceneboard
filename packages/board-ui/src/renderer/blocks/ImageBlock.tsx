'use client';

import React, { useRef, useState, type CSSProperties } from 'react';
import { MAX_MEDIA_PIXELS } from '@sceneboard/board-schema';

import { EXPORT_TRUSTED_IMAGE_URL_V1, type RendererComponentV1 } from '../renderer-types.js';

export type ImageStateV1 =
  | Readonly<{
      requestKey: string;
      status: 'loaded';
      width: number;
      height: number;
      trustedKind: 'broker' | 'artifact' | null;
    }>
  | Readonly<{
      requestKey: string;
      status: 'error';
      trustedKind: 'broker' | 'artifact' | null;
    }>;

type ImageStyleV1 = CSSProperties &
  Readonly<Record<'--scene-image-aspect-ratio' | '--scene-image-intrinsic-width', string>>;

const unavailable = (alt: string, decorative: boolean | undefined, caption?: string) => (
  <figure
    className="scene-block scene-image scene-image-unavailable"
    data-public-render-terminal="true"
    aria-hidden={decorative === true ? true : undefined}
  >
    <div
      className="scene-image-fallback"
      {...(decorative === true ? {} : { role: 'img', 'aria-label': alt })}
    >
      <span aria-hidden="true">▧</span>
      {decorative !== true && <span>Image unavailable.</span>}
    </div>
    {caption !== undefined && <figcaption>{caption}</figcaption>}
  </figure>
);

const exportUnsupported = (kind: 'broker' | 'artifact') => (
  <section data-export-unsupported={`${kind}-image`}>Required export image is unavailable.</section>
);

const safeRelativeUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  try {
    const parsed = new URL(value, 'https://sceneboard.invalid');
    return (
      parsed.origin === 'https://sceneboard.invalid' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
};

const safeTrustedExportUrl = (
  resolution: Exclude<
    ReturnType<
      NonNullable<Parameters<RendererComponentV1<'content.image'>>[0]['context']['mediaResolver']>
    >,
    { error: string }
  >,
): boolean => {
  const trust = resolution[EXPORT_TRUSTED_IMAGE_URL_V1];
  if (trust === undefined || !/^[0-9a-f]{64}$/u.test(trust.sha256)) return false;
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(resolution.url))
    return true;
  if (trust.kind === 'artifact') return false;
  try {
    const parsed = new URL(resolution.url);
    return (
      parsed.protocol === 'http:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      new RegExp(
        `/internal/v1/export-render/[A-Za-z0-9_-]{22}/resources/${trust.sha256}$`,
        'u',
      ).test(parsed.pathname)
    );
  } catch {
    return false;
  }
};

const safeMetadata = (
  value: unknown,
): value is Readonly<{
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  etag: string;
}> => {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = value as Record<string, unknown>;
  return (
    Object.keys(metadata).length === 4 &&
    ['image/png', 'image/jpeg', 'image/webp'].includes(String(metadata.mime)) &&
    Number.isSafeInteger(metadata.width) &&
    Number(metadata.width) > 0 &&
    Number.isSafeInteger(metadata.height) &&
    Number(metadata.height) > 0 &&
    Number(metadata.width) * Number(metadata.height) <= MAX_MEDIA_PIXELS &&
    typeof metadata.etag === 'string' &&
    /^"sha256-[0-9a-f]{64}"$/u.test(metadata.etag)
  );
};

type ImageBlockPropsV1 = Parameters<RendererComponentV1<'content.image'>>[0];

export const renderImageBlockV1 = (
  { node, context }: ImageBlockPropsV1,
  imageState: ImageStateV1 | null,
  setImageState: (state: ImageStateV1) => void,
  requestKeyRef: { current: string },
) => {
  let resolution: ReturnType<NonNullable<typeof context.mediaResolver>> | null = null;
  try {
    resolution =
      context.mediaResolver?.(
        node.source.type === 'media'
          ? {
              mediaId: node.source.mediaId,
              boardId: context.boardId,
              revisionId: context.revisionId,
              pageId: context.selectedPageId,
            }
          : {
              artifact: node.source.artifact,
              path: node.source.path,
              sha256: node.source.sha256,
              boardId: context.boardId,
              revisionId: context.revisionId,
              pageId: context.selectedPageId,
            },
      ) ?? null;
  } catch {
    resolution = null;
  }
  if (resolution !== null && 'error' in resolution && resolution.error === 'pending')
    return (
      <figure
        className="scene-block scene-image scene-image-unavailable"
        data-export-pending="image"
        aria-busy="true"
      >
        <div className="scene-image-fallback">Loading verified image.</div>
      </figure>
    );
  const trustedKind = resolution?.[EXPORT_TRUSTED_IMAGE_URL_V1]?.kind;
  if (
    node.source.type === 'artifact.resource' &&
    (resolution === null ||
      ('error' in resolution && resolution[EXPORT_TRUSTED_IMAGE_URL_V1]?.kind !== 'artifact'))
  ) {
    const artifact = node.source.artifact;
    const runtime = context.artifacts.find(
      (item) =>
        item.artifact.artifactId === artifact.artifactId &&
        item.artifact.versionId === artifact.versionId,
    );
    return (
      <figure
        className="scene-block scene-placeholder"
        data-public-render-terminal="true"
        aria-hidden={node.decorative === true ? true : undefined}
      >
        <div className="scene-placeholder-icon" aria-hidden="true">
          ▧
        </div>
        <figcaption>
          <strong>{node.alt}</strong>
          {node.caption && <span>{node.caption}</span>}
          <span>Verified image delivery is unavailable in this release.</span>
          <span>Artifact status: {runtime?.status ?? 'unavailable'}</span>
        </figcaption>
      </figure>
    );
  }
  if (
    resolution === null ||
    'error' in resolution ||
    (!safeRelativeUrl(resolution.url) && !safeTrustedExportUrl(resolution)) ||
    (node.source.type === 'artifact.resource' &&
      resolution[EXPORT_TRUSTED_IMAGE_URL_V1]?.kind !== 'artifact') ||
    (resolution.metadata !== undefined && !safeMetadata(resolution.metadata))
  )
    return trustedKind !== undefined ? (
      exportUnsupported(trustedKind)
    ) : node.source.type === 'artifact.resource' ? (
      <section data-export-unsupported="artifact-image">
        Required artifact image is unavailable.
      </section>
    ) : (
      unavailable(node.alt, node.decorative, node.caption)
    );

  const metadata = resolution.metadata;
  const requestKey = `${trustedKind ?? 'ordinary'}\0${resolution.url}\0${metadata?.etag ?? resolution[EXPORT_TRUSTED_IMAGE_URL_V1]?.sha256 ?? 'account'}`;
  requestKeyRef.current = requestKey;
  if (imageState?.requestKey === requestKey && imageState.status === 'error')
    return imageState.trustedKind === null
      ? unavailable(node.alt, node.decorative, node.caption)
      : exportUnsupported(imageState.trustedKind);
  const dimensions =
    imageState?.requestKey === requestKey && imageState.status === 'loaded'
      ? imageState
      : (metadata ?? null);
  const style: ImageStyleV1 = {
    '--scene-image-aspect-ratio':
      dimensions === null ? '16 / 9' : `${dimensions.width} / ${dimensions.height}`,
    '--scene-image-intrinsic-width':
      dimensions === null ? '100%' : `${dimensions.width.toString()}px`,
  };
  return (
    <figure
      className="scene-block scene-image"
      aria-hidden={node.decorative === true ? true : undefined}
      data-fit={node.fit}
      style={style}
    >
      <div
        className="scene-image-frame"
        aria-busy={
          imageState?.requestKey === requestKey && imageState.status === 'loaded' ? undefined : true
        }
      >
        <img
          data-public-render-resource="image"
          key={requestKey}
          src={resolution.url}
          alt={node.decorative === true ? '' : node.alt}
          className="scene-image-content"
          draggable={false}
          onLoad={(event) => {
            if (requestKeyRef.current !== requestKey) return;
            const width = event.currentTarget.naturalWidth;
            const height = event.currentTarget.naturalHeight;
            if (
              !Number.isSafeInteger(width) ||
              width <= 0 ||
              !Number.isSafeInteger(height) ||
              height <= 0 ||
              width * height > MAX_MEDIA_PIXELS
            ) {
              setImageState({ requestKey, status: 'error', trustedKind: trustedKind ?? null });
              return;
            }
            setImageState({
              requestKey,
              status: 'loaded',
              width,
              height,
              trustedKind: trustedKind ?? null,
            });
          }}
          onError={() => {
            if (requestKeyRef.current === requestKey)
              setImageState({ requestKey, status: 'error', trustedKind: trustedKind ?? null });
          }}
        />
        {imageState?.requestKey !== requestKey && (
          <span className="scene-image-loading" role="status">
            Loading image.
          </span>
        )}
      </div>
      {node.caption !== undefined && <figcaption>{node.caption}</figcaption>}
    </figure>
  );
};

export const ImageBlock: RendererComponentV1<'content.image'> = (props) => {
  const requestKeyRef = useRef('');
  const [imageState, setImageState] = useState<ImageStateV1 | null>(null);
  return renderImageBlockV1(props, imageState, setImageState, requestKeyRef);
};
