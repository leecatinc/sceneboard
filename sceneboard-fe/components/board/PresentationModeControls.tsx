'use client';

import type { RefObject } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import styles from './PresentationModeControls.module.css';

export function PresentationModeControls({
  active,
  disabled,
  buttonRef,
  onEnter,
  onExit,
}: {
  active: boolean;
  disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onEnter: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.controls}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-pressed={active}
        onClick={active ? onExit : onEnter}
      >
        {active ? t('presentation.exitPresentation') : t('presentation.enterPresentation')}
      </button>
    </div>
  );
}
