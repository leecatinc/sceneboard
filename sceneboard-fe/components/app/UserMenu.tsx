'use client';

import { useEffect, useRef, useState } from 'react';

import { authSessionClient } from '../../lib/auth/session-client';
import { LanguageSelect } from '../i18n/LanguageSelect';
import { useI18n } from '../i18n/I18nProvider';
import { AccountModal } from './AccountModal';
import { PasswordChangeForm } from './PasswordChangeForm';

type AccountDialog = 'settings' | 'password';

export function UserMenu() {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [activeDialog, setActiveDialog] = useState<AccountDialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const email = authSessionClient().snapshot()?.user.email ?? '';

  useEffect(() => {
    if (!isOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  async function signOut() {
    setError(null);
    const result = await authSessionClient().logout();
    if (result.kind === 'ok') window.location.assign('/login');
    else setError(t('user.signOutFailed'));
  }

  function openDialog(dialog: AccountDialog) {
    setIsOpen(false);
    setActiveDialog(dialog);
  }

  function closeDialog() {
    setActiveDialog(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu-trigger"
        aria-label={t('user.openMenu')}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="user-avatar" aria-hidden="true">
          {email.slice(0, 1).toUpperCase() || 'S'}
        </span>
        <span className="user-email">{email}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {isOpen && (
        <div className="user-menu-popover" role="menu" aria-label={t('user.accountMenu')}>
          <div className="user-menu-identity">
            <span>{t('user.signedInAs')}</span>
            <strong>{email}</strong>
          </div>
          <button type="button" role="menuitem" onClick={() => openDialog('settings')}>
            {t('nav.settings')}
          </button>
          <button type="button" role="menuitem" onClick={() => openDialog('password')}>
            {t('user.changePassword')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="user-menu-signout"
            onClick={() => void signOut()}
          >
            {t('user.signOut')}
          </button>
          {error && (
            <p className="error user-menu-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <AccountModal
        isOpen={activeDialog === 'settings'}
        onDismiss={closeDialog}
        title={t('settings.title')}
        description={t('settings.description')}
      >
        <LanguageSelect id="account-language" autoFocus />
      </AccountModal>
      <AccountModal
        isOpen={activeDialog === 'password'}
        onDismiss={closeDialog}
        title={t('user.changePassword')}
        description={t('settings.passwordDescription')}
      >
        <PasswordChangeForm />
      </AccountModal>
    </div>
  );
}
