ALTER TABLE board_idempotency_records
  DROP CHECK chk_idempotency_scope_shape,
  DROP CHECK chk_idempotency_fingerprint,
  DROP CHECK chk_idempotency_status,
  MODIFY COLUMN fingerprint_payload LONGBLOB NOT NULL,
  MODIFY COLUMN result_payload LONGBLOB NULL,
  ADD CONSTRAINT chk_idempotency_scope_shape CHECK (
    (scope_code = 'C' AND scope_subject = 'board.create'
      AND expected_revision_id IS NULL AND operation_type = 'board.create')
    OR
    (scope_code = 'A' AND scope_subject <> 'board.create'
      AND expected_revision_id IS NULL AND operation_type = 'board.archive')
    OR
    (scope_code = 'M' AND scope_subject <> 'board.create'
      AND expected_revision_id IS NOT NULL AND operation_type IN (
        'scene.replace','scene.clear','scene.restore','hitl.request','hitl.respond',
        'artifact.publish','artifact.stop','document.replace'
      ))
  ),
  ADD CONSTRAINT chk_idempotency_fingerprint CHECK (
    fingerprint_version = 1
    AND fingerprint_canonical_bytes BETWEEN 1 AND 33554432
    AND fingerprint_canonical_bytes = OCTET_LENGTH(fingerprint_payload)
  ),
  ADD CONSTRAINT chk_idempotency_status CHECK (
    (status_code = 'P' AND result_payload IS NULL
      AND result_canonical_bytes IS NULL AND result_sha256 IS NULL
      AND completed_at IS NULL AND expires_at IS NULL)
    OR
    (status_code = 'C' AND result_payload IS NOT NULL
      AND result_canonical_bytes IS NOT NULL
      AND result_canonical_bytes BETWEEN 1 AND 33554432
      AND result_canonical_bytes = OCTET_LENGTH(result_payload)
      AND result_sha256 IS NOT NULL
      AND completed_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > completed_at)
  );
