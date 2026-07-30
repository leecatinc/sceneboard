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
  variant = 'default',
}: {
  active: boolean;
  disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onEnter: () => void;
  onExit: () => void;
  variant?: 'default' | 'rail';
}) {
  const { t } = useI18n();
  const label = active ? t('presentation.exitPresentation') : t('presentation.enterPresentation');
  return (
    <div className={variant === 'rail' ? styles.railControls : styles.controls}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-pressed={active}
        aria-label={label}
        title={label}
        onClick={active ? onExit : onEnter}
      >
        {variant === 'rail' ? (
          <>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="3"
                y="4"
                width="18"
                height="13"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M9.5 9l5 2.5-5 2.5V9zM9 21h6M12 17v4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="visually-hidden">{label}</span>
          </>
        ) : (
          label
        )}
      </button>
    </div>
  );
}
