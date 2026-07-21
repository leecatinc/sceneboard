'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import styles from './AccountModal.module.css';

export function AccountModal({
  isOpen,
  onDismiss,
  title,
  description,
  children,
}: {
  isOpen: boolean;
  onDismiss: () => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, [isOpen]);

  if (!isOpen) return null;
  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <section className={styles.panel}>
        <header className={styles.header}>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label={t('common.dismiss')}
            onClick={onDismiss}
          >
            ×
          </button>
        </header>
        <div className={styles.content}>{children}</div>
      </section>
    </dialog>
  );
}
