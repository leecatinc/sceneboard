'use client';

import type { ArtifactViewModeV1 } from '@sceneboard/board-ui/artifact';
import { useI18n } from '../i18n/I18nProvider';

const MODES: readonly ArtifactViewModeV1[] = ['fill', 'fit-page', 'fit-width', 'actual'];

export function BoardViewModeControls({
  value,
  zoom,
  canReset,
  onChange,
  onReset,
  compact = false,
}: {
  value: ArtifactViewModeV1;
  zoom: number | null;
  canReset: boolean;
  onChange: (mode: ArtifactViewModeV1) => void;
  onReset: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const labels: Readonly<Record<ArtifactViewModeV1, string>> = {
    fill: t('presentation.fillArea'),
    'fit-page': t('presentation.fitPage'),
    'fit-width': t('presentation.fitWidth'),
    actual: compact ? '100%' : t('presentation.actualSize'),
  };
  return (
    <div
      className={`board-view-modes${compact ? ' is-compact' : ''}`}
      role="group"
      aria-label={t('board.viewMode')}
    >
      {MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          {labels[mode]}
        </button>
      ))}
      {!compact && (
        <>
          <output aria-label={t('board.artifactZoomStatus')} aria-live="polite">
            {zoom === null ? t('board.artifactZoomUnavailable') : `${Math.round(zoom * 100)}%`}
          </output>
          <button
            type="button"
            disabled={!canReset || zoom === null || value !== 'actual'}
            onClick={onReset}
          >
            {t('board.resetArtifactView')}
          </button>
        </>
      )}
    </div>
  );
}
