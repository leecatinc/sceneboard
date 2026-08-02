'use client';

import { useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import styles from './ClipboardCopyButton.module.css';

const TOAST_DURATION_MS = 2_000;

export function ClipboardCopyButton({
  value,
  className = 'button',
  onCopied,
  onCopyFailed,
  autoFocus = false,
}: {
  value: string;
  className?: string;
  onCopied?: () => void;
  onCopyFailed?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      onCopyFailed?.();
      return;
    }
    if (onCopied !== undefined) {
      onCopied();
      return;
    }
    setCopied(true);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setCopied(false);
      timeoutRef.current = null;
    }, TOAST_DURATION_MS);
  }

  return (
    <>
      <button type="button" className={className} autoFocus={autoFocus} onClick={() => void copy()}>
        {t('ai.copyCode')}
      </button>
      {copied && (
        <div className={styles.toast} role="status" aria-live="polite">
          {t('ai.copiedToClipboard')}
        </div>
      )}
    </>
  );
}
