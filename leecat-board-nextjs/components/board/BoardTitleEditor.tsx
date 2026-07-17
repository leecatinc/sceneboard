'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n/I18nProvider';

export function BoardTitleEditor({ title, onRename }: {
  title: string;
  onRename: (title: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setError(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = String(new FormData(event.currentTarget).get('title') ?? '').trim();
    if (nextTitle === '' || [...nextTitle].length > 200) {
      setError(true);
      return;
    }
    if (nextTitle === title) {
      cancel();
      return;
    }
    setSaving(true);
    setError(false);
    const renamed = await onRename(nextTitle);
    setSaving(false);
    if (renamed) setEditing(false);
    else setError(true);
  };

  if (!editing) {
    return (
      <div className="board-title-row">
        <h2>{title}</h2>
        <button
          type="button"
          className="board-title-edit"
          aria-label={t('board.rename')}
          title={t('board.rename')}
          onClick={() => setEditing(true)}
        >✎</button>
      </div>
    );
  }

  return (
    <form className="board-title-form" onSubmit={submit}>
      <input ref={input} name="title" defaultValue={title} maxLength={200} required aria-label={t('board.name')} />
      <button type="submit" className="board-title-save" disabled={saving}>{saving ? t('board.savingName') : t('board.saveName')}</button>
      <button type="button" className="board-title-cancel" disabled={saving} onClick={cancel}>{t('board.cancelRename')}</button>
      {error && <span className="board-title-error" role="alert">{t('board.renameFailed')}</span>}
    </form>
  );
}
