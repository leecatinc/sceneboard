'use client';

import { useState } from 'react';

import type { GrantSummary } from '../../../lib/api/board-api';
import { visibleApprovedGrants } from '../../../lib/ai-connections/visible-approved-grants';
import { useI18n } from '../../../components/i18n/I18nProvider';
import { ConfirmationDialog } from '../../../components/app/ConfirmationDialog';

export function GrantList({
  grants,
  busyGrantId,
  onRotate,
  onRevoke,
}: {
  grants: GrantSummary[];
  busyGrantId: string | null;
  onRotate: (grantId: string) => void;
  onRevoke: (grantId: string) => Promise<boolean>;
}) {
  const { formatDateTime, t } = useI18n();
  const [disconnecting, setDisconnecting] = useState<GrantSummary | null>(null);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const visibleGrants = visibleApprovedGrants(grants);
  if (visibleGrants.length === 0) return <p className="muted">{t('ai.noApproved')}</p>;
  return (
    <>
      <div className="grid">
        {visibleGrants.map((grant) => (
          <article className="item" key={grant.grantId}>
            <h3>{grant.client.clientName}</h3>
            <p className="muted">
              {grant.status} · {grant.lifetime}
            </p>
            <div className="meta">
              {grant.scopes.map((scope) => (
                <span className="pill" key={scope}>
                  {scope}
                </span>
              ))}
            </div>
            <p className="muted">{t('ai.expires', { date: formatDateTime(grant.expiresAt) })}</p>
            <div className="actions">
              {grant.status === 'active' && (
                <button
                  className="button secondary"
                  disabled={busyGrantId !== null}
                  onClick={() => onRotate(grant.grantId)}
                >
                  {t('ai.rotate')}
                </button>
              )}
              <button
                className="button danger"
                disabled={busyGrantId !== null}
                onClick={() => {
                  setDisconnectFailed(false);
                  setDisconnecting(grant);
                }}
              >
                {t('ai.disconnect')}
              </button>
            </div>
          </article>
        ))}
      </div>
      <ConfirmationDialog
        isOpen={disconnecting !== null}
        title={t('ai.disconnectTitle')}
        description={t('ai.disconnectDescription', {
          client: disconnecting?.client.clientName ?? '',
        })}
        confirmLabel={t('ai.disconnectConfirm')}
        cancelLabel={t('common.cancel')}
        busy={disconnecting !== null && busyGrantId === disconnecting.grantId}
        error={disconnectFailed ? t('ai.disconnectFailed') : null}
        onConfirm={() => {
          if (disconnecting === null) return;
          void onRevoke(disconnecting.grantId).then((ok) => {
            if (ok) setDisconnecting(null);
            else setDisconnectFailed(true);
          });
        }}
        onDismiss={() => {
          setDisconnecting(null);
          setDisconnectFailed(false);
        }}
      />
    </>
  );
}
