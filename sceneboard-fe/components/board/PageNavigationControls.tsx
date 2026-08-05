'use client';

import React from 'react';

export function PageNavigationControls({
  current,
  total,
  previousLabel,
  nextLabel,
  statusLabel,
  onPrevious,
  onNext,
  navigationDisabled = false,
}: {
  current: number;
  total: number;
  previousLabel: string;
  nextLabel: string;
  statusLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  navigationDisabled?: boolean;
}) {
  if (total <= 1) return null;

  return (
    <nav className="page-navigation" aria-label={statusLabel} data-page-bottom-navigation>
      <button
        type="button"
        className="page-navigation-button"
        aria-label={previousLabel}
        disabled={navigationDisabled || current <= 1}
        onClick={onPrevious}
      >
        ‹
      </button>
      <span className="page-navigation-status">
        {current} / {total}
      </span>
      <button
        type="button"
        className="page-navigation-button"
        aria-label={nextLabel}
        disabled={navigationDisabled || current >= total}
        onClick={onNext}
      >
        ›
      </button>
    </nav>
  );
}
