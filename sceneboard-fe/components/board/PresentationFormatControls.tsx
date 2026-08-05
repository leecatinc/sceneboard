'use client';

import { useEffect, useId, useState } from 'react';
import type { PresentationFormatV1 } from '@sceneboard/board-schema';

import { useI18n } from '../i18n/I18nProvider';
import styles from './PresentationFormatControls.module.css';

const OPTIONS = [
  ['wide_16_9', 'presentation.formatWide'],
  ['standard_4_3', 'presentation.formatStandard'],
  ['a4_portrait', 'presentation.formatA4Portrait'],
  ['a4_landscape', 'presentation.formatA4Landscape'],
] as const satisfies ReadonlyArray<
  readonly [PresentationFormatV1, Parameters<ReturnType<typeof useI18n>['t']>[0]]
>;

export function PresentationFormatControls({
  value,
  canEdit,
  onChange,
}: {
  value: PresentationFormatV1;
  canEdit: boolean;
  onChange: (format: PresentationFormatV1) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const selectId = useId();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(value);

  useEffect(() => {
    if (!pending) setSelected(value);
  }, [pending, value]);

  return (
    <div className={styles.controls}>
      <label className={styles.label} htmlFor={selectId}>
        {t('presentation.documentFormat')}
      </label>
      <select
        id={selectId}
        className={styles.select}
        value={selected}
        disabled={!canEdit || pending}
        aria-describedby={`${selectId}-status`}
        onChange={(event) => {
          const next = event.currentTarget.value as PresentationFormatV1;
          if (next === value || pending || !canEdit) return;
          setSelected(next);
          setPending(true);
          setFailed(false);
          void onChange(next).then((ok) => {
            setFailed(!ok);
            if (!ok) setSelected(value);
            setPending(false);
          });
        }}
      >
        {OPTIONS.map(([format, label]) => (
          <option key={format} value={format}>
            {t(label)}
          </option>
        ))}
      </select>
      <span id={`${selectId}-status`} className={styles.status} role="status" aria-live="polite">
        {pending
          ? t('presentation.formatSaving')
          : failed
            ? t('presentation.formatSaveFailed')
            : ''}
      </span>
    </div>
  );
}
