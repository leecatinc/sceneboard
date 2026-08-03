CREATE TABLE export_terminal_audit_intents (
  terminal_audit_intent_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  correlation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_kind ENUM('user','service') NOT NULL,
  actor_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  format ENUM('pdf','pptx') NOT NULL,
  revision_number BIGINT UNSIGNED NOT NULL,
  outcome ENUM('pending','completed','failed') NOT NULL,
  completed_bytes BIGINT UNSIGNED NULL,
  failure_reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  persisted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (terminal_audit_intent_pk),
  UNIQUE KEY uq_export_terminal_audit_correlation (correlation_id),
  KEY ix_export_terminal_audit_recovery (outcome, persisted_at, terminal_audit_intent_pk),
  CONSTRAINT chk_export_terminal_audit_correlation CHECK (
    CHAR_LENGTH(correlation_id) BETWEEN 1 AND 64
  ),
  CONSTRAINT chk_export_terminal_audit_actor CHECK (
    CHAR_LENGTH(actor_public_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT chk_export_terminal_audit_revision CHECK (
    revision_number BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_export_terminal_audit_payload CHECK (
    (outcome = 'pending' AND completed_bytes IS NULL AND failure_reason IS NULL
      AND persisted_at IS NULL)
    OR
    (outcome = 'completed' AND completed_bytes BETWEEN 0 AND 9007199254740991
      AND failure_reason IS NULL)
    OR
    (outcome = 'failed' AND completed_bytes IS NULL AND failure_reason IN (
      'EXPORT_INVALID_REQUEST',
      'EXPORT_UNAUTHENTICATED',
      'EXPORT_FORBIDDEN',
      'EXPORT_NOT_FOUND',
      'EXPORT_REQUIRED_CONTENT_UNSUPPORTED',
      'EXPORT_BOUNDS_EXCEEDED',
      'EXPORT_RATE_LIMITED',
      'EXPORT_RENDERER_UNAVAILABLE',
      'EXPORT_RENDER_TIMEOUT',
      'EXPORT_ENCODE_FAILED',
      'EXPORT_INTERNAL_ERROR'
    ))
  )
);
