'use client';

import { useEffect } from 'react';

import type { CreatedPairing } from '../../../lib/api/board-api';
import { ClipboardCopyButton } from '../../../components/ai-connections/ClipboardCopyButton';
import { useI18n } from '../../../components/i18n/I18nProvider';

export function PairingCard({
  pairing,
  onDismiss,
}: {
  pairing: CreatedPairing;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const remaining = Math.max(0, Date.parse(pairing.codeExpiresAt) - Date.now());
    const timeout = window.setTimeout(onDismiss, remaining);
    return () => window.clearTimeout(timeout);
  }, [onDismiss, pairing.codeExpiresAt]);

  return (
    <article className="item" aria-labelledby={`pairing-${pairing.pairingId}`}>
      <h3 id={`pairing-${pairing.pairingId}`}>{t('ai.oneTimeCode')}</h3>
      <p className="muted">{t('ai.codeDescription')}</p>
      <div className="code">{pairing.code}</div>
      <div className="actions">
        <ClipboardCopyButton value={pairing.code} />
        <button className="button secondary" onClick={onDismiss}>
          {t('common.dismiss')}
        </button>
      </div>
    </article>
  );
}
