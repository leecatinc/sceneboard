'use client';

import type { GrantSummary } from '../../../lib/api/board-api';
import { useI18n } from '../../../components/i18n/I18nProvider';

export function GrantList({
  grants,
  busyGrantId,
  onRotate,
  onRevoke,
}: {
  grants: GrantSummary[];
  busyGrantId: string | null;
  onRotate: (grantId: string) => void;
  onRevoke: (grantId: string) => void;
}) {
  const { formatDateTime, t } = useI18n();
  if (grants.length === 0) return <p className="muted">{t('ai.noApproved')}</p>;
  return (
    <div className="grid">
      {grants.map((grant) => (
        <article className="item" key={grant.grantId}>
          <h3>{grant.client.clientName}</h3>
          <p className="muted">{grant.status} · {grant.lifetime}</p>
          <div className="meta">{grant.scopes.map((scope) => <span className="pill" key={scope}>{scope}</span>)}</div>
          <p className="muted">{t('ai.expires', { date: formatDateTime(grant.expiresAt) })}</p>
          {grant.status === 'active' && (
            <div className="actions">
              <button className="button secondary" disabled={busyGrantId !== null} onClick={() => onRotate(grant.grantId)}>{t('ai.rotate')}</button>
              <button className="button danger" disabled={busyGrantId !== null} onClick={() => onRevoke(grant.grantId)}>{t('ai.revoke')}</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
