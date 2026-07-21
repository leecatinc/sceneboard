'use client';

import type { PairingOwnerStatus } from '../../../lib/api/board-api';
import { useI18n } from '../../../components/i18n/I18nProvider';
import styles from '../../../components/ai-connections/pairing-request.module.css';

export function PairingRequestList({
  pairings,
  selectedPairingId,
  onSelect,
}: {
  pairings: PairingOwnerStatus[];
  selectedPairingId: string | null;
  onSelect: (pairingId: string) => void;
}) {
  const { t } = useI18n();
  if (pairings.length === 0) return <div className={styles.empty}>{t('ai.noPairingRequests')}</div>;
  return (
    <div className={styles.requestList}>
      {pairings.map((pairing) => {
        const name = pairing.client?.clientName ?? t('ai.waitingClient');
        const permissionCount =
          pairing.requestedScopes.length + pairing.requestedLifecyclePermissions.length;
        return (
          <button
            type="button"
            className={`${styles.requestRow} ${selectedPairingId === pairing.pairingId ? styles.requestRowSelected : ''}`}
            key={pairing.pairingId}
            aria-haspopup="dialog"
            onClick={() => onSelect(pairing.pairingId)}
          >
            <span className={styles.requestIdentity}>
              <strong>{name}</strong>
              <span>{pairing.client?.installationFingerprint ?? t('ai.waitingClient')}</span>
            </span>
            <span className={styles.state}>{pairing.state.replace('_', ' ')}</span>
            <span className={styles.permissionCount}>
              {t('ai.permissionCount', { count: permissionCount })}
            </span>
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          </button>
        );
      })}
    </div>
  );
}
