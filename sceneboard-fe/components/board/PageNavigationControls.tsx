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
}: {
  current: number;
  total: number;
  previousLabel: string;
  nextLabel: string;
  statusLabel: string;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav className="page-navigation" aria-label={statusLabel} data-page-bottom-navigation>
      {total > 1 && (
        <button
          type="button"
          className="page-navigation-button"
          aria-label={previousLabel}
          disabled={current <= 1}
          onClick={onPrevious}
        >
          ‹
        </button>
      )}
      <span className="page-navigation-status">
        {current} / {total}
      </span>
      {total > 1 && (
        <button
          type="button"
          className="page-navigation-button"
          aria-label={nextLabel}
          disabled={current >= total}
          onClick={onNext}
        >
          ›
        </button>
      )}
    </nav>
  );
}
