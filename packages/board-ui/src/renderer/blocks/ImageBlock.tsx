'use client';

import { useRef, useState, type CSSProperties } from 'react';
import { MAX_MEDIA_PIXELS } from '@sceneboard/board-schema';

import type { RendererComponentV1 } from '../renderer-types.js';

type ImageStateV1 =
  | Readonly<{ requestKey: string; status: 'loaded'; width: number; height: number }>
  | Readonly<{ requestKey: string; status: 'error' }>;

type ImageStyleV1 = CSSProperties &
  Readonly<Record<'--scene-image-aspect-ratio' | '--scene-image-intrinsic-width', string>>;

const unavailable = (alt: string, decorative: boolean | undefined, caption?: string) => (
  <figure
    className="scene-block scene-image scene-image-unavailable"
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

export const ImageBlock: RendererComponentV1<'content.image'> = ({ node, context }) => {
  const requestKeyRef = useRef('');
  const [imageState, setImageState] = useState<ImageStateV1 | null>(null);
  const artifact = node.source.type === 'artifact.resource' ? node.source.artifact : null;
  const runtime =
    artifact === null
      ? undefined
      : context.artifacts.find(
          (item) =>
            item.artifact.artifactId === artifact.artifactId &&
            item.artifact.versionId === artifact.versionId,
        );
  if (node.source.type === 'artifact.resource')
    return (
      <figure
        className="scene-block scene-placeholder"
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

  let resolution: ReturnType<NonNullable<typeof context.mediaResolver>> | null = null;
  try {
    resolution =
      context.mediaResolver?.({
        mediaId: node.source.mediaId,
        boardId: context.boardId,
        revisionId: context.revisionId,
        pageId: context.selectedPageId,
      }) ?? null;
  } catch {
    resolution = null;
  }
  if (
    resolution === null ||
    'error' in resolution ||
    !safeRelativeUrl(resolution.url) ||
    (resolution.metadata !== undefined && !safeMetadata(resolution.metadata))
  )
    return unavailable(node.alt, node.decorative, node.caption);

  const metadata = resolution.metadata;
  const requestKey = `${resolution.url}\0${metadata?.etag ?? 'account'}`;
  requestKeyRef.current = requestKey;
  if (imageState?.requestKey === requestKey && imageState.status === 'error')
    return unavailable(node.alt, node.decorative, node.caption);
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
              setImageState({ requestKey, status: 'error' });
              return;
            }
            setImageState({ requestKey, status: 'loaded', width, height });
          }}
          onError={() => {
            if (requestKeyRef.current === requestKey)
              setImageState({ requestKey, status: 'error' });
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
