'use client';

import type { PageDisplayModeV1 } from '../../lib/board/page-display-mode.types';
import { useI18n } from '../i18n/I18nProvider';
import styles from './PageDisplayModeControls.module.css';

const MODES: readonly PageDisplayModeV1[] = ['fit-page', 'fit-width', 'actual-size'];

export function PageDisplayModeControls({
  value,
  onChange,
}: {
  value: PageDisplayModeV1;
  onChange: (mode: PageDisplayModeV1) => void;
}) {
  const { t } = useI18n();
  const labels: Readonly<Record<PageDisplayModeV1, string>> = {
    'fit-page': t('presentation.fitPage'),
    'fit-width': t('presentation.fitWidth'),
    'actual-size': t('presentation.actualSize'),
  };
  return (
    <div className={styles.controls} role="group" aria-label={t('presentation.displayMode')}>
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
    </div>
  );
}
