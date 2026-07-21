CREATE TABLE board_idempotency_records (
  record_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_id BINARY(16) NOT NULL,
  scope_code CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_subject VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint_version TINYINT UNSIGNED NOT NULL,
  fingerprint_payload MEDIUMBLOB NOT NULL,
  fingerprint_canonical_bytes INT UNSIGNED NOT NULL,
  fingerprint_sha256 BINARY(32) NOT NULL,
  actor_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  actor_scopes_payload VARBINARY(512) NOT NULL,
  actor_scopes_sha256 BINARY(32) NOT NULL,
  expected_revision_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  command_payload_sha256 BINARY(32) NOT NULL,
  initial_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status_code CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_payload MEDIUMBLOB NULL,
  result_canonical_bytes INT UNSIGNED NULL,
  result_sha256 BINARY(32) NULL,
  result_board_pk BIGINT UNSIGNED NULL,
  result_revision_pk BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  expires_at DATETIME(3) NULL,
  PRIMARY KEY (record_pk),
  UNIQUE KEY uq_idempotency_record_id (record_id),
  UNIQUE KEY uq_idempotency_scope (
    scope_code, principal_kind, principal_id, scope_subject, idempotency_key
  ),
  KEY ix_idempotency_result_revision (result_board_pk, result_revision_pk),
  KEY ix_idempotency_expiry (status_code, expires_at, record_pk),
  CONSTRAINT fk_idempotency_result_board FOREIGN KEY (result_board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_idempotency_result_revision FOREIGN KEY (result_board_pk, result_revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_idempotency_scope_code CHECK (scope_code IN ('M','C','A')),
  CONSTRAINT chk_idempotency_principal_kind CHECK (principal_kind IN ('U','M','S')),
  CONSTRAINT chk_idempotency_actor_grant CHECK (
    (principal_kind = 'M' AND actor_grant_id IS NOT NULL)
    OR (principal_kind IN ('U','S') AND actor_grant_id IS NULL)
  ),
  CONSTRAINT chk_idempotency_scope_shape CHECK (
    (scope_code = 'C' AND scope_subject = 'board.create'
      AND expected_revision_id IS NULL AND operation_type = 'board.create')
    OR
    (scope_code = 'A' AND scope_subject <> 'board.create'
      AND expected_revision_id IS NULL AND operation_type = 'board.archive')
    OR
    (scope_code = 'M' AND scope_subject <> 'board.create'
      AND expected_revision_id IS NOT NULL AND operation_type IN (
        'scene.replace','scene.clear','scene.restore','hitl.request','hitl.respond',
        'artifact.publish','artifact.stop'
      ))
  ),
  CONSTRAINT chk_idempotency_key CHECK (CHAR_LENGTH(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT chk_idempotency_fingerprint CHECK (
    fingerprint_version = 1
    AND fingerprint_canonical_bytes BETWEEN 1 AND 1048576
    AND fingerprint_canonical_bytes = OCTET_LENGTH(fingerprint_payload)
  ),
  CONSTRAINT chk_idempotency_scopes CHECK (OCTET_LENGTH(actor_scopes_payload) BETWEEN 2 AND 512),
  CONSTRAINT chk_idempotency_status CHECK (
    (status_code = 'P' AND result_payload IS NULL
      AND result_canonical_bytes IS NULL AND result_sha256 IS NULL
      AND completed_at IS NULL AND expires_at IS NULL)
    OR
    (status_code = 'C' AND result_payload IS NOT NULL
      AND result_canonical_bytes IS NOT NULL
      AND result_canonical_bytes BETWEEN 1 AND 1048576
      AND result_canonical_bytes = OCTET_LENGTH(result_payload)
      AND result_sha256 IS NOT NULL
      AND completed_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > completed_at)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
