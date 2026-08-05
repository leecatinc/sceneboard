export function OwnerAdminActionIcon({
  kind,
}: {
  kind: 'share' | 'members' | 'export' | 'settings';
}) {
  if (kind === 'share') {
    return (
      <svg className="board-owner-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M9.5 14.5l5-5M7.2 16.8l-1.4 1.4a3.4 3.4 0 004.8 4.8l3.1-3.1a3.4 3.4 0 000-4.8M16.8 7.2l1.4-1.4a3.4 3.4 0 00-4.8-4.8l-3.1 3.1a3.4 3.4 0 000 4.8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'members') {
    return (
      <svg className="board-owner-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M8.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6 6 0 0112 0M16.5 10a3 3 0 100-6M16 14a5.5 5.5 0 015.5 5.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'settings') {
    return (
      <svg className="board-owner-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg className="board-owner-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3v12m0 0l-4-4m4 4l4-4M5 20h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
