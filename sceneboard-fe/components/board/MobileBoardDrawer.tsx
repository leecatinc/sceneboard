'use client';

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import styles from './MobileBoardDrawer.module.css';
import {
  mobileBoardDrawerSlotSignatureV1,
  reduceMobileBoardDrawerV1,
} from './mobile-board-drawer-state';

export type MobileBoardDrawerSlotsV1 = Readonly<{
  boardIdentity: ReactNode | null;
  pageDisplay: ReactNode | null;
  mediaAuthoring: ReactNode | null;
  history: ReactNode | null;
  status: ReactNode | null;
  connections: ReactNode | null;
  ownerAdmin: ReactNode | null;
}>;

const FOCUSABLE =
  'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

export function MobileBoardDrawer({
  slots,
  routeKey,
  backgroundRef,
}: {
  slots: MobileBoardDrawerSlotsV1;
  routeKey: string;
  backgroundRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openingTriggerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const slotsRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousRouteRef = useRef(routeKey);
  const slotSignature = mobileBoardDrawerSlotSignatureV1([
    slots.boardIdentity,
    slots.pageDisplay,
    slots.mediaAuthoring,
    slots.history,
    slots.status,
    slots.connections,
    slots.ownerAdmin,
  ]);
  const [drawerState, dispatchDrawer] = useReducer(reduceMobileBoardDrawerV1, {
    open: false,
    dialogEpoch: 0,
    slotSignature,
  });
  const { open } = drawerState;

  const restoreFocus = useCallback(() => {
    const openingTrigger = openingTriggerRef.current;
    openingTriggerRef.current = null;
    requestAnimationFrame(() => {
      if (openingTrigger?.isConnected) openingTrigger.focus();
      else if (triggerRef.current?.isConnected) triggerRef.current.focus();
      else document.querySelector<HTMLElement>('[data-page-heading]')?.focus();
    });
  }, []);
  const close = useCallback(
    (restore = true) => {
      dispatchDrawer({ type: 'close' });
      if (restore) restoreFocus();
    },
    [restoreFocus],
  );

  useEffect(() => {
    if (previousRouteRef.current !== routeKey && open) close();
    previousRouteRef.current = routeKey;
  }, [close, open, routeKey]);
  useEffect(() => {
    dispatchDrawer({ type: 'slots-hydrated', slotSignature });
  }, [slotSignature]);
  useEffect(() => {
    if (!open) return;
    const background = backgroundRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    if (background !== null) {
      background.inert = true;
      background.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = 'hidden';
    document.body.classList.add('mobile-board-drawer-open');
    requestAnimationFrame(() => {
      const firstAction = slotsRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (firstAction ?? closeRef.current)?.focus();
    });
    return () => {
      if (background !== null) {
        background.inert = false;
        background.removeAttribute('aria-hidden');
      }
      document.body.style.overflow = previousBodyOverflow;
      document.body.classList.remove('mobile-board-drawer-open');
    };
  }, [backgroundRef, open]);
  useEffect(() => {
    if (!open || dialogRef.current?.contains(document.activeElement)) return;
    closeRef.current?.focus();
  }, [drawerState.slotSignature, open]);
  useEffect(
    () => () => {
      const openingTrigger = openingTriggerRef.current;
      if (openingTrigger === null) return;
      requestAnimationFrame(() => {
        if (openingTrigger?.isConnected) openingTrigger.focus();
        else document.querySelector<HTMLElement>('[data-page-heading]')?.focus();
      });
    },
    [],
  );

  const trapAndClose = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length === 0) {
      event.preventDefault();
      closeRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const orderedSlots: readonly [keyof MobileBoardDrawerSlotsV1, ReactNode | null][] = [
    ['boardIdentity', slots.boardIdentity],
    ['pageDisplay', slots.pageDisplay],
    ['mediaAuthoring', slots.mediaAuthoring],
    ['history', slots.history],
    ['status', slots.status],
    ['connections', slots.connections],
    ['ownerAdmin', slots.ownerAdmin],
  ];
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} mobile-board-drawer-trigger`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          openingTriggerRef.current = event.currentTarget;
          dispatchDrawer({ type: 'open' });
        }}
      >
        {t('presentation.boardControls')}
      </button>
      {open && (
        <div
          className={styles.backdrop}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label={t('presentation.boardControls')}
            data-mobile-drawer-dialog-epoch={drawerState.dialogEpoch}
            onKeyDown={trapAndClose}
          >
            <div className={styles.header}>
              <strong>{t('presentation.boardControls')}</strong>
              <button
                ref={closeRef}
                type="button"
                aria-label={t('presentation.closeBoardControls')}
                onClick={() => close()}
              >
                ×
              </button>
            </div>
            <div ref={slotsRef} className={styles.body} data-mobile-drawer-scroll-owner>
              {orderedSlots.map(
                ([name, node]) =>
                  node !== null && (
                    <section key={name} className={styles.slot} data-mobile-drawer-slot={name}>
                      {node}
                    </section>
                  ),
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
