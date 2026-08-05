'use client';

import type { PresentationFormatV1 } from '@sceneboard/board-schema';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  BoardExportApi,
  publishBoardExportDownloadV1,
  type BoardExportFailureCodeV1,
  type BoardExportFormatV1,
} from '../../lib/api/board-export-api';
import { useI18n } from '../i18n/I18nProvider';
import type { OwnerAdminCloseRegistration } from './OwnerAdminControls';
import { OwnerAdminActionIcon } from './OwnerAdminActionIcon';
import { PresentationFormatControls } from './PresentationFormatControls';
import styles from './BoardExportControl.module.css';

type ExportPhaseV1 = 'idle' | 'confirming' | 'generating' | 'completed' | 'failed' | 'retry';

type ExportStateV1 = Readonly<{
  phase: ExportPhaseV1;
  failure: Readonly<{
    code: BoardExportFailureCodeV1 | 'EXPORT_RESPONSE_INVALID' | 'EXPORT_BROWSER_UNAVAILABLE';
    retryable: boolean;
  }> | null;
}>;

type ExportFailureCodeV1 = NonNullable<ExportStateV1['failure']>['code'];

type ExportTargetV1 = Readonly<{
  boardId: string;
  boardTitle: string;
  revisionId: string;
  revisionNumber: number;
}>;

const failureLabelKey = (code: ExportFailureCodeV1) => {
  if (code === 'EXPORT_REQUIRED_CONTENT_UNSUPPORTED')
    return 'presentation.exportContentUnsupported' as const;
  if (code === 'EXPORT_BOUNDS_EXCEEDED') return 'presentation.exportTooLarge' as const;
  if (
    code === 'EXPORT_RATE_LIMITED' ||
    code === 'EXPORT_RENDERER_UNAVAILABLE' ||
    code === 'EXPORT_RENDER_TIMEOUT' ||
    code === 'EXPORT_ENCODE_FAILED' ||
    code === 'EXPORT_INTERNAL_ERROR'
  )
    return 'presentation.exportTemporaryFailed' as const;
  return 'presentation.exportFailed' as const;
};

export function BoardExportControl({
  api,
  boardId,
  boardTitle,
  revisionId,
  revisionNumber,
  documentFormat,
  canEditDocumentFormat,
  onDocumentFormatChange,
  enabled,
  routeKey,
  forcedCloseEpoch,
  registerClose,
}: {
  api: BoardExportApi;
  boardId: string;
  boardTitle: string;
  revisionId: string;
  revisionNumber: number;
  documentFormat: PresentationFormatV1;
  canEditDocumentFormat: boolean;
  onDocumentFormatChange: (format: PresentationFormatV1) => Promise<boolean>;
  enabled: boolean;
  routeKey: string;
  forcedCloseEpoch: number;
  registerClose: OwnerAdminCloseRegistration;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestFormatRef = useRef<BoardExportFormatV1 | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<BoardExportFormatV1>('pdf');
  const [target, setTarget] = useState<ExportTargetV1 | null>(null);
  const [state, setState] = useState<ExportStateV1>({ phase: 'idle', failure: null });

  const close = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    requestFormatRef.current = null;
    setOpen(false);
    setTarget(null);
    setState({ phase: 'idle', failure: null });
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      document.body.style.overflow = overflow;
      if (dialog.open) dialog.close();
    };
  }, [open]);

  useEffect(() => {
    if (!enabled && open) close();
  }, [close, enabled, open]);

  useEffect(() => close, [close, routeKey]);
  useEffect(() => registerClose(close), [close, registerClose]);
  useEffect(() => close(), [close, forcedCloseEpoch]);

  useEffect(() => {
    if (!open || (state.phase !== 'confirming' && state.phase !== 'idle')) return;
    setTarget({ boardId, boardTitle, revisionId, revisionNumber });
  }, [boardId, boardTitle, documentFormat, open, revisionId, revisionNumber, state.phase]);

  const begin = useCallback(
    async (retry: boolean) => {
      const requestFormat = retry ? requestFormatRef.current : format;
      if (target === null || requestFormat === null) return;
      if (!retry) requestFormatRef.current = requestFormat;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setState({ phase: retry ? 'retry' : 'generating', failure: null });
      try {
        const result = await api.export({
          boardId: target.boardId,
          revisionId: target.revisionId,
          format: requestFormat,
          signal: controller.signal,
        });
        if (controller.signal.aborted || requestRef.current !== controller) return;
        if (result.kind === 'error') {
          requestRef.current = null;
          setState({ phase: 'failed', failure: result.error });
          return;
        }
        publishBoardExportDownloadV1(result.value, {
          createObjectUrl: (blob) => URL.createObjectURL(blob),
          revokeObjectUrl: (url) => {
            setTimeout(() => URL.revokeObjectURL(url), 0);
          },
          clickDownload: ({ url, fileName }) => {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = fileName;
            anchor.rel = 'noopener';
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
          },
        });
        requestRef.current = null;
        setState({ phase: 'completed', failure: null });
      } catch {
        if (controller.signal.aborted || requestRef.current !== controller) return;
        requestRef.current = null;
        setState({
          phase: 'failed',
          failure: { code: 'EXPORT_BROWSER_UNAVAILABLE', retryable: false },
        });
      }
    },
    [api, format, target],
  );

  if (!enabled) return null;
  const busy = state.phase === 'generating' || state.phase === 'retry';
  const status =
    state.phase === 'generating'
      ? t('presentation.exportGenerating')
      : state.phase === 'retry'
        ? t('presentation.exportRetrying')
        : state.phase === 'completed'
          ? t('presentation.exportCompleted')
          : state.phase === 'failed' && state.failure !== null
            ? t(failureLabelKey(state.failure.code))
            : '';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="button secondary board-owner-action-button"
        aria-label={t('presentation.exportAction')}
        title={t('presentation.exportAction')}
        onClick={() => {
          setTarget({
            boardId,
            boardTitle,
            revisionId,
            revisionNumber,
          });
          requestFormatRef.current = null;
          setState({ phase: 'confirming', failure: null });
          setOpen(true);
        }}
      >
        <OwnerAdminActionIcon kind="export" />
      </button>
      {open && target !== null && (
        <dialog
          ref={dialogRef}
          className={styles.dialog}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section className={styles.panel}>
            <header className={styles.header}>
              <h2 id={titleId}>{t('presentation.exportDialogTitle')}</h2>
              <button type="button" className="button secondary" onClick={close}>
                {busy ? t('common.cancel') : t('presentation.exportClose')}
              </button>
            </header>
            <div className={styles.content}>
              <p id={descriptionId}>{t('presentation.exportDialogDescription')}</p>
              <dl className={styles.summary}>
                <div>
                  <dt>{t('presentation.exportBoard')}</dt>
                  <dd>{target.boardTitle}</dd>
                </div>
                <div>
                  <dt>{t('presentation.exportRevision')}</dt>
                  <dd>{t('boards.revision', { number: target.revisionNumber })}</dd>
                </div>
              </dl>
              <PresentationFormatControls
                value={documentFormat}
                canEdit={canEditDocumentFormat && !busy}
                onChange={onDocumentFormatChange}
              />
              <fieldset
                className={styles.formats}
                disabled={state.phase !== 'confirming' && state.phase !== 'idle'}
              >
                <legend>{t('presentation.exportFormatLegend')}</legend>
                {(['pdf', 'pptx'] as const).map((candidate) => (
                  <label key={candidate}>
                    <input
                      type="radio"
                      name="board-export-format"
                      value={candidate}
                      checked={format === candidate}
                      onChange={() => setFormat(candidate)}
                    />
                    {t(candidate === 'pdf' ? 'presentation.exportPdf' : 'presentation.exportPptx')}
                  </label>
                ))}
              </fieldset>
              {status !== '' && (
                <p
                  className={state.phase === 'failed' ? styles.error : styles.status}
                  role={state.phase === 'failed' ? 'alert' : 'status'}
                  aria-live="polite"
                >
                  {status}
                </p>
              )}
              <div className={styles.actions}>
                {(state.phase === 'confirming' || state.phase === 'idle') && (
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => void begin(false)}
                  >
                    {t('presentation.exportConfirm')}
                  </button>
                )}
                {state.phase === 'failed' && state.failure?.retryable === true && (
                  <button type="button" className="button primary" onClick={() => void begin(true)}>
                    {t('common.retry')}
                  </button>
                )}
              </div>
            </div>
          </section>
        </dialog>
      )}
    </>
  );
}
