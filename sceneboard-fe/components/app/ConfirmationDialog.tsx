'use client';

import { useEffect, useId, useRef } from 'react';

import styles from './ConfirmationDialog.module.css';

export function ConfirmationDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  cancelLabel,
  busy,
  error,
  confirmTone = 'danger',
  onConfirm,
  onDismiss,
}: {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  error: string | null;
  confirmTone?: 'primary' | 'danger';
  onConfirm: () => void;
  onDismiss: () => void;
}) {
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
  const dismiss = () => {
    if (!busy) onDismiss();
  };
  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <section className={styles.panel}>
        <h2 id={titleId}>{title}</h2>
        <p className={styles.description} id={descriptionId}>
          {description}
        </p>
        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className="button secondary" disabled={busy} onClick={dismiss}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button${confirmTone === 'danger' ? ' danger' : ''}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </dialog>
  );
}
