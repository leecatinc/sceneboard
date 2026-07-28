CREATE TABLE IF NOT EXISTS board_revision_payloads (
  revision_pk BIGINT UNSIGNED NOT NULL,
  schema_version CHAR(5) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  codec CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  canonical_bytes INT UNSIGNED NOT NULL,
  stored_bytes INT UNSIGNED NOT NULL,
  payload_sha256 BINARY(32) NOT NULL,
  payload LONGBLOB NOT NULL,
  state ENUM('available','reclaiming') NOT NULL,
  PRIMARY KEY (revision_pk),
  KEY ix_revision_payloads_state (state, revision_pk),
  CONSTRAINT fk_revision_payloads_revision FOREIGN KEY (revision_pk)
    REFERENCES board_revisions (revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_revision_payloads_checkpoint CHECK (
    codec = 'B'
    AND stored_bytes = OCTET_LENGTH(payload)
    AND (
      (
        schema_version = '1.0.0'
        AND canonical_bytes BETWEEN 1 AND 786432
        AND stored_bytes BETWEEN 1 AND 800000
      )
      OR (
        schema_version = '2.0.0'
        AND canonical_bytes BETWEEN 1 AND 20971520
        AND stored_bytes BETWEEN 1 AND 33554432
      )
    )
  ),
  CONSTRAINT chk_revision_payloads_state CHECK (state IN ('available','reclaiming'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS board_revision_catalog (
  board_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  retained_order BIGINT UNSIGNED NOT NULL,
  is_head TINYINT UNSIGNED NOT NULL,
  truncated_before TINYINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_pk, revision_pk),
  UNIQUE KEY uq_revision_catalog_order (board_pk, retained_order),
  KEY ix_revision_catalog_head (board_pk, is_head, retained_order),
  CONSTRAINT fk_revision_catalog_revision FOREIGN KEY (board_pk, revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_revision_catalog_order CHECK (
    retained_order BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_revision_catalog_flags CHECK (
    is_head IN (0,1) AND truncated_before IN (0,1)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS board_revision_holds (
  board_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  kind ENUM('published','media','artifact','idempotency','outbox','recovery','restore') NOT NULL,
  holder_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NULL,
  released_at DATETIME(3) NULL,
  PRIMARY KEY (board_pk, revision_pk, kind, holder_id),
  KEY ix_revision_holds_active (board_pk, released_at, expires_at, revision_pk),
  CONSTRAINT fk_revision_holds_revision FOREIGN KEY (board_pk, revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_revision_holds_kind CHECK (
    kind IN ('published','media','artifact','idempotency','outbox','recovery','restore')
  ),
  CONSTRAINT chk_revision_holds_holder CHECK (CHAR_LENGTH(holder_id) BETWEEN 1 AND 191)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS board_revision_recovery (
  recovery_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  phase ENUM(
    'planned',
    'core_applied',
    'refs_detached',
    'payload_cleared',
    'catalog_removed',
    'complete',
    'quarantined'
  ) NOT NULL,
  lease_owner VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  attempts SMALLINT UNSIGNED NOT NULL,
  last_error VARCHAR(1024) NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (recovery_id),
  KEY ix_revision_recovery_discovery (phase, lease_expires_at, recovery_id),
  KEY ix_revision_recovery_revision (board_pk, revision_pk, phase),
  CONSTRAINT fk_revision_recovery_revision FOREIGN KEY (board_pk, revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_revision_recovery_phase CHECK (
    phase IN (
      'planned',
      'core_applied',
      'refs_detached',
      'payload_cleared',
      'catalog_removed',
      'complete',
      'quarantined'
    )
  ),
  CONSTRAINT chk_revision_recovery_lease CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT chk_revision_recovery_complete CHECK (
    phase <> 'complete' OR (lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT chk_revision_recovery_attempts CHECK (attempts <= 65535),
  CONSTRAINT chk_revision_recovery_id CHECK (CHAR_LENGTH(recovery_id) BETWEEN 1 AND 191)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
