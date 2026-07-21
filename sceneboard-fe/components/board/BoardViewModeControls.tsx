'use client';

import type { ArtifactViewModeV1 } from '@sceneboard/board-ui/artifact';
import { useI18n } from '../i18n/I18nProvider';

const MODES: readonly ArtifactViewModeV1[] = ['fit-height', 'fit-width', 'actual'];

export function BoardViewModeControls({
  value,
  zoom,
  canReset,
  onChange,
  onReset,
}: {
  value: ArtifactViewModeV1;
  zoom: number | null;
  canReset: boolean;
  onChange: (mode: ArtifactViewModeV1) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const labels: Readonly<Record<ArtifactViewModeV1, string>> = {
    'fit-height': t('board.fitHeight'),
    'fit-width': t('board.fitWidth'),
    actual: t('board.actualSize'),
  };
  return (
    <div className="board-view-modes" role="group" aria-label={t('board.viewMode')}>
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
    </div>
  );
}
