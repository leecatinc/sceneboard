'use client';

import type { ReactNode } from 'react';
import { useRef, useSyncExternalStore } from 'react';

import { BoardTopBar } from './BoardTopBar';
import { MobileBoardDrawer, type MobileBoardDrawerSlotsV1 } from './MobileBoardDrawer';

const MOBILE_QUERY = '(max-width: 760px)';

function subscribeMobile(listener: () => void) {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

const getMobileSnapshot = () => window.matchMedia(MOBILE_QUERY).matches;
const getMobileServerSnapshot = () => false;

export function ResponsiveBoardChrome({
  slots,
  routeKey,
  presentationActive,
  notice,
  surfaceClassName,
  children,
}: {
  slots: MobileBoardDrawerSlotsV1;
  routeKey: string;
  presentationActive: boolean;
  notice: ReactNode;
  surfaceClassName: string;
  children: ReactNode;
}) {
  const mobile = useSyncExternalStore(subscribeMobile, getMobileSnapshot, getMobileServerSnapshot);
  const backgroundRef = useRef<HTMLDivElement | null>(null);

  if (mobile) {
    return (
      <>
        {!presentationActive && (
          <MobileBoardDrawer slots={slots} routeKey={routeKey} backgroundRef={backgroundRef} />
        )}
        <div key="mobile-board-background" ref={backgroundRef} className="mobile-board-background">
          {!presentationActive && notice}
          <div key="board-surface" className={`board-surface ${surfaceClassName}`}>
            {children}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {!presentationActive && (
        <BoardTopBar
          boardIdentity={slots.boardIdentity}
          pageDisplay={slots.pageDisplay}
          mediaAuthoring={slots.mediaAuthoring}
          history={slots.history}
          connections={slots.connections}
          ownerAdmin={slots.ownerAdmin}
        />
      )}
      {!presentationActive && notice}
      <div key="board-surface" className={`board-surface ${surfaceClassName}`}>
        {children}
        {!presentationActive && slots.status}
      </div>
    </>
  );
}
