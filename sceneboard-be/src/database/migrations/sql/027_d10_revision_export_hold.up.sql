ALTER TABLE board_revision_holds
  MODIFY COLUMN kind ENUM(
    'published',
    'media',
    'artifact',
    'idempotency',
    'outbox',
    'recovery',
    'restore',
    'export'
  ) NOT NULL,
  DROP CHECK chk_revision_holds_kind,
  ADD CONSTRAINT chk_revision_holds_kind CHECK (
    kind IN (
      'published',
      'media',
      'artifact',
      'idempotency',
      'outbox',
      'recovery',
      'restore',
      'export'
    )
  );
