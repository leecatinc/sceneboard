'use client';

import type { BoardSnapshotV1, PresenceSummaryV1 } from '@sceneboard/board-schema';
import { useI18n } from '../i18n/I18nProvider';

export function StatusRail({
  snapshot,
  presence,
  onStopRendering,
}: {
  snapshot: BoardSnapshotV1;
  presence: readonly PresenceSummaryV1[];
  onStopRendering: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className="status-rail" aria-label={t('board.status')}>
      <h3>{t('board.status')}</h3>
      <dl>
        <div>
          <dt>{t('board.revisionLabel')}</dt>
          <dd>{snapshot.revision.revisionNumber}</dd>
        </div>
        <div>
          <dt>{t('board.aiPresence')}</dt>
          <dd>{presence.length}</dd>
        </div>
        <div>
          <dt>{t('board.interactions')}</dt>
          <dd>{snapshot.hitl.filter((item) => item.state === 'open').length}</dd>
        </div>
        <div>
          <dt>{t('board.artifacts')}</dt>
          <dd>{snapshot.artifacts.length}</dd>
        </div>
      </dl>
      <details>
        <summary>{t('board.capabilities')}</summary>
        <ul>
          {snapshot.capabilities.grantedCapabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </details>
      {snapshot.artifacts.length > 0 && (
        <button type="button" className="artifact-stop-sidebar" onClick={onStopRendering}>
          {t('board.stopRendering')}
        </button>
      )}
    </aside>
  );
}
