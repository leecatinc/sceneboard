'use client';

import type { ChangeEvent, DragEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BoardDocumentV2,
  MediaIngestResultV1,
  NodeId,
  PageId,
  RevisionId,
} from '@sceneboard/board-schema';
import {
  placeMediaImageOnPageV1,
  type MediaImagePlacementV1,
} from '@sceneboard/board-sdk/document-transform';

import { useI18n } from '../i18n/I18nProvider';
import { createBoardRequestIdentity } from '../../lib/api/board-api';
import { BoardDocumentApi } from '../../lib/api/board-document-api';
import {
  BoardMediaUploadApi,
  type PreparedMediaUploadV1,
} from '../../lib/api/board-media-upload-api';
import type { DocumentMutationRequest } from '../../lib/api/board-api-types';
import type { SessionRequestCoordinator } from '../../lib/auth/renewal-singleflight';
import type { PageCanvasTransformV1, PageRectV1 } from '../../lib/board/page-display-mode.types';
import {
  chooseMediaImagePlacementV1,
  createMediaImageNodeV1,
  mediaImageProjectionV1,
  type ImageAuthoringPhaseV1,
} from '../../lib/board/image-authoring-controller';
import styles from './BoardImageUploadControl.module.css';

type PlacementIntent = Readonly<{
  image: NonNullable<ReturnType<typeof createMediaImageNodeV1>>;
  placement: MediaImagePlacementV1;
}>;

const mediaErrorMessageKey = (code: string) => {
  if (code === 'INVALID_REQUEST' || code === 'INVALID_MEDIA_UPLOAD')
    return 'mediaAuthoring.error.invalid' as const;
  if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED')
    return 'mediaAuthoring.error.forbidden' as const;
  if (code === 'BOARD_NOT_FOUND') return 'mediaAuthoring.error.notFound' as const;
  if (code === 'PAYLOAD_TOO_LARGE') return 'mediaAuthoring.error.tooLarge' as const;
  if (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_RESULT_EXPIRED')
    return 'mediaAuthoring.error.conflict' as const;
  if (code === 'RATE_LIMITED') return 'mediaAuthoring.error.rateLimited' as const;
  if (code === 'SERVICE_UNAVAILABLE') return 'mediaAuthoring.error.unavailable' as const;
  return 'mediaAuthoring.error.generic' as const;
};

const localNodeId = (prefix: 'image' | 'media_layout'): NodeId => {
  const requestId = createBoardRequestIdentity().requestId.replace(/^req_/u, '');
  return `${prefix}_${requestId}` as NodeId;
};

const oneFileCandidate = (dataTransfer: DataTransfer): File | null => {
  const items = Array.from(dataTransfer.items);
  if (items.length !== 1 || items[0]?.kind !== 'file') return null;
  return items[0].getAsFile();
};

export function BoardImageUploadControl({
  coordinator,
  boardId,
  document,
  pageId,
  expectedRevisionId,
  onRefresh,
  onPlaced,
  resolveCanvasViewport,
}: {
  coordinator: SessionRequestCoordinator;
  boardId: string;
  document: BoardDocumentV2;
  pageId: PageId;
  expectedRevisionId: RevisionId;
  onRefresh: () => Promise<void>;
  onPlaced: () => Promise<void>;
  resolveCanvasViewport: () => Readonly<{
    transform: PageCanvasTransformV1;
    pageViewportRect: PageRectV1;
    scrollTop: number;
  }> | null;
}) {
  const { t } = useI18n();
  const mediaApi = useMemo(() => new BoardMediaUploadApi(coordinator), [coordinator]);
  const documentApi = useMemo(() => new BoardDocumentApi(coordinator), [coordinator]);
  const [phase, setPhase] = useState<ImageAuthoringPhaseV1>('idle');
  const [prepared, setPrepared] = useState<PreparedMediaUploadV1 | null>(null);
  const [uploaded, setUploaded] = useState<MediaIngestResultV1 | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [decorative, setDecorative] = useState(false);
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [fit, setFit] = useState<'contain' | 'cover' | 'fill' | 'none'>('contain');
  const [messageKey, setMessageKey] = useState<string>('mediaAuthoring.ready');
  const epoch = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const placementIntent = useRef<PlacementIntent | null>(null);
  const placementAttempt = useRef<DocumentMutationRequest | null>(null);

  const revokePreview = useCallback(() => {
    setPreview((current) => {
      if (current !== null) URL.revokeObjectURL(current);
      return null;
    });
  }, []);
  const scrub = useCallback(
    (restart: boolean) => {
      epoch.current += 1;
      abort.current?.abort();
      abort.current = null;
      setPrepared(null);
      setUploaded(null);
      placementIntent.current = null;
      placementAttempt.current = null;
      setAlt('');
      setCaption('');
      setDecorative(false);
      revokePreview();
      setPhase(restart ? 'failure' : 'idle');
      setMessageKey(restart ? 'mediaAuthoring.restart' : 'mediaAuthoring.ready');
    },
    [revokePreview],
  );
  const finishSuccess = useCallback(() => {
    epoch.current += 1;
    abort.current?.abort();
    abort.current = null;
    setPrepared(null);
    setUploaded(null);
    placementIntent.current = null;
    placementAttempt.current = null;
    setAlt('');
    setCaption('');
    setDecorative(false);
    revokePreview();
    setPhase('success');
    setMessageKey('mediaAuthoring.success');
  }, [revokePreview]);
  useEffect(() => () => scrub(false), [scrub]);
  useEffect(() => {
    if (prepared === null) return;
    return coordinator.subscribeGenerationInvalidation(prepared.attempt.binding, () => scrub(true));
  }, [coordinator, prepared, scrub]);

  const upload = useCallback(
    async (value: PreparedMediaUploadV1, ownedEpoch: number) => {
      const controller = new AbortController();
      abort.current = controller;
      setPhase('uploading');
      setMessageKey('mediaAuthoring.uploading');
      const result = await mediaApi.upload(value, controller.signal);
      if (epoch.current !== ownedEpoch) return;
      abort.current = null;
      if (result.kind === 'ok') {
        setUploaded(result.value);
        setPhase('authoring');
        setMessageKey('mediaAuthoring.describe');
        return;
      }
      if (result.kind === 'commit_uncertain') {
        setPhase('upload-uncertain');
        setMessageKey('mediaAuthoring.uploadUncertain');
        return;
      }
      if (result.kind === 'stale_attempt' || result.kind === 'unsupported_browser') {
        scrub(true);
        return;
      }
      setPhase('failure');
      setMessageKey(mediaErrorMessageKey(result.error.code));
    },
    [mediaApi, scrub],
  );

  const selectFile = useCallback(
    async (file: File) => {
      scrub(false);
      const ownedEpoch = epoch.current;
      setPreview(URL.createObjectURL(file));
      setPhase('hashing');
      setMessageKey('mediaAuthoring.hashing');
      const identity = createBoardRequestIdentity();
      const csrfToken = coordinator.currentSnapshot()?.csrfToken;
      if (csrfToken === undefined) {
        scrub(true);
        return;
      }
      const result = await mediaApi.bind({
        boardId,
        file,
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        csrfToken,
      });
      if (epoch.current !== ownedEpoch) return;
      if (result.kind !== 'bound') {
        if (result.kind === 'invalid_file') {
          setPhase('failure');
          setMessageKey('mediaAuthoring.invalidFile');
        } else scrub(true);
        return;
      }
      setPrepared(result.value);
      await upload(result.value, ownedEpoch);
    },
    [boardId, coordinator, mediaApi, scrub, upload],
  );

  const dispatchPlacement = useCallback(
    async (request: DocumentMutationRequest, ownedEpoch: number) => {
      if (prepared === null) return;
      const controller = new AbortController();
      abort.current = controller;
      setPhase('placing');
      setMessageKey('mediaAuthoring.placing');
      const result = await documentApi.replaceForGeneration(
        prepared.attempt.binding,
        request,
        controller.signal,
      );
      if (epoch.current !== ownedEpoch) return;
      abort.current = null;
      if (result.kind === 'ok') {
        finishSuccess();
        await onPlaced();
        return;
      }
      if (result.kind === 'stale_attempt' || result.kind === 'unsupported_browser') {
        scrub(true);
        return;
      }
      if (result.kind === 'commit_uncertain') {
        setPhase('failure');
        setMessageKey('mediaAuthoring.placementUncertain');
        return;
      }
      if (result.kind === 'board_error' && result.error.code === 'REVISION_CONFLICT') {
        placementAttempt.current = null;
        setPhase('placement-conflict');
        setMessageKey('mediaAuthoring.placementConflict');
        await onRefresh();
        return;
      }
      placementAttempt.current = null;
      setPhase('failure');
      setMessageKey(
        result.kind === 'board_error'
          ? mediaErrorMessageKey(result.error.code)
          : 'mediaAuthoring.error.generic',
      );
    },
    [documentApi, finishSuccess, onPlaced, onRefresh, prepared, scrub],
  );

  const place = useCallback(
    async (replay: boolean) => {
      if (prepared === null || uploaded === null) return;
      const ownedEpoch = epoch.current;
      if (replay && placementAttempt.current !== null) {
        await dispatchPlacement(placementAttempt.current, ownedEpoch);
        return;
      }
      const image =
        placementIntent.current?.image ??
        createMediaImageNodeV1({
          nodeId: localNodeId('image'),
          mediaId: uploaded.media.mediaId,
          authoring: decorative
            ? { decorative: true, alt: '', fit }
            : {
                decorative: false,
                alt,
                ...(caption.trim() === '' ? {} : { caption }),
                fit,
              },
        });
      if (image === null) {
        setPhase('failure');
        setMessageKey('mediaAuthoring.invalidDescription');
        return;
      }
      const placement =
        placementIntent.current?.placement ??
        chooseMediaImagePlacementV1({
          document,
          pageId,
          wrapperNodeId: localNodeId('media_layout'),
          intrinsicWidth: uploaded.media.width,
          intrinsicHeight: uploaded.media.height,
          canvasViewport: resolveCanvasViewport(),
        });
      if (placement === null) {
        setPhase('failure');
        setMessageKey('mediaAuthoring.placementUnavailable');
        return;
      }
      const logical = placementIntent.current ?? { image, placement };
      placementIntent.current = logical;
      const projection = mediaImageProjectionV1({ document, pageId, ...logical });
      if (projection === 'exact') {
        finishSuccess();
        return;
      }
      if (projection === 'collision') {
        scrub(false);
        setPhase('failure');
        setMessageKey('mediaAuthoring.placementCollision');
        return;
      }
      const transformed = placeMediaImageOnPageV1({ document, pageId, ...logical });
      if (!transformed.ok) {
        setPhase('failure');
        setMessageKey('mediaAuthoring.placementUnavailable');
        return;
      }
      const identity = createBoardRequestIdentity();
      const request: DocumentMutationRequest = {
        protocolVersion: 1,
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        boardId: boardId as never,
        expectedRevisionId,
        command: { type: 'document.replace', document: transformed.data.value },
      };
      placementAttempt.current = request;
      await dispatchPlacement(request, ownedEpoch);
    },
    [
      alt,
      boardId,
      caption,
      decorative,
      dispatchPlacement,
      document,
      expectedRevisionId,
      fit,
      finishSuccess,
      pageId,
      prepared,
      resolveCanvasViewport,
      scrub,
      uploaded,
    ],
  );

  const onPicker = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file !== undefined) void selectFile(file);
  };
  const ownsDrag = (event: DragEvent<HTMLDivElement>): boolean =>
    event.currentTarget.contains(event.target as Node) &&
    Array.from(event.dataTransfer.items).length === 1 &&
    event.dataTransfer.items[0]?.kind === 'file';

  return (
    <div className={styles.control} data-media-authoring-phase={phase}>
      <div
        className={styles.drop}
        aria-label={t('mediaAuthoring.dropLabel')}
        onDragOver={(event) => {
          if (!ownsDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          if (!ownsDrag(event)) return;
          const file = oneFileCandidate(event.dataTransfer);
          if (file === null) return;
          event.preventDefault();
          void selectFile(file);
        }}
      >
        <span>{t('mediaAuthoring.dropHint')}</span>
        <label>
          <span>{t('mediaAuthoring.picker')}</span>
          <input
            className={styles.picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={onPicker}
          />
        </label>
      </div>
      {preview !== null && (
        <img className={styles.preview} src={preview} alt="" aria-hidden="true" />
      )}
      {uploaded !== null && (
        <div className={styles.fields}>
          <label>
            <span>{t('mediaAuthoring.alt')}</span>
            <input
              value={alt}
              maxLength={500}
              disabled={decorative}
              required={!decorative}
              onChange={(event) => setAlt(event.currentTarget.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={decorative}
              onChange={(event) => {
                setDecorative(event.currentTarget.checked);
                if (event.currentTarget.checked) {
                  setAlt('');
                  setCaption('');
                }
              }}
            />
            <span>{t('mediaAuthoring.decorative')}</span>
          </label>
          <label>
            <span>{t('mediaAuthoring.caption')}</span>
            <input
              value={caption}
              maxLength={500}
              disabled={decorative}
              onChange={(event) => setCaption(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>{t('mediaAuthoring.fit')}</span>
            <select
              value={fit}
              onChange={(event) => setFit(event.currentTarget.value as typeof fit)}
            >
              <option value="contain">{t('mediaAuthoring.fit.contain')}</option>
              <option value="cover">{t('mediaAuthoring.fit.cover')}</option>
              <option value="fill">{t('mediaAuthoring.fit.fill')}</option>
              <option value="none">{t('mediaAuthoring.fit.none')}</option>
            </select>
          </label>
        </div>
      )}
      <p className={styles.status} role="status" aria-live="polite">
        {t(messageKey as never)}
      </p>
      <div className={styles.actions}>
        {phase === 'upload-uncertain' && prepared !== null && (
          <button type="button" onClick={() => void upload(prepared, epoch.current)}>
            {t('mediaAuthoring.retryUpload')}
          </button>
        )}
        {phase === 'authoring' && (
          <button type="button" onClick={() => void place(false)}>
            {t('mediaAuthoring.place')}
          </button>
        )}
        {phase === 'placement-conflict' && (
          <button type="button" onClick={() => void place(false)}>
            {t('mediaAuthoring.retryPlacement')}
          </button>
        )}
        {phase === 'failure' && placementAttempt.current !== null && (
          <button type="button" onClick={() => void place(true)}>
            {t('mediaAuthoring.retryPlacement')}
          </button>
        )}
        {phase !== 'idle' && phase !== 'success' && (
          <button type="button" onClick={() => scrub(false)}>
            {t('common.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}
