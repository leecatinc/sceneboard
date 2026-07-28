'use client';

import { useI18n } from '../i18n/I18nProvider';
import styles from './PageMoveModeControls.module.css';

export function PageMoveModeControls({
  available,
  active,
  onChange,
}: {
  available: boolean;
  active: boolean;
  onChange: (active: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={styles.button}
      disabled={!available}
      aria-pressed={active}
      onClick={() => onChange(!active)}
    >
      {active ? t('presentation.stopMoving') : t('presentation.movePage')}
    </button>
  );
}
