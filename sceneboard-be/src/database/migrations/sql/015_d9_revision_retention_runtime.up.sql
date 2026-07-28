ALTER TABLE board_revision_catalog
  ADD COLUMN actor_account_pk BIGINT UNSIGNED NULL AFTER truncated_before,
  ADD COLUMN actor_class ENUM('owner','editor','system') NULL AFTER actor_account_pk;

UPDATE board_revision_catalog c
JOIN board_revisions r ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
JOIN boards b ON b.board_pk = c.board_pk
LEFT JOIN users u ON r.actor_kind = 'U' AND u.public_id = r.actor_principal_id
SET c.actor_account_pk = u.id,
    c.actor_class = CASE
      WHEN r.actor_kind = 'S' THEN 'system'
      WHEN u.id = b.owner_user_id THEN 'owner'
      ELSE 'editor'
    END
WHERE c.actor_class IS NULL;

ALTER TABLE board_revision_catalog
  MODIFY COLUMN actor_class ENUM('owner','editor','system') NOT NULL,
  ADD KEY ix_revision_catalog_actor (actor_account_pk, board_pk, retained_order),
  ADD CONSTRAINT fk_revision_catalog_actor FOREIGN KEY (actor_account_pk)
    REFERENCES users (id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS board_retention_leases (
  board_pk BIGINT UNSIGNED NOT NULL,
  run_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_token VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fence BIGINT UNSIGNED NOT NULL,
  lease_expires_at DATETIME(3) NOT NULL,
  renewed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_pk),
  KEY ix_retention_leases_expiry (lease_expires_at, board_pk),
  CONSTRAINT fk_retention_leases_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_retention_leases_identity CHECK (
    CHAR_LENGTH(run_id) BETWEEN 1 AND 36
    AND CHAR_LENGTH(owner_token) BETWEEN 1 AND 191
    AND fence BETWEEN 1 AND 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS board_retention_runs (
  run_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  state ENUM('planned','running','complete','quarantined') NOT NULL,
  attempt SMALLINT UNSIGNED NOT NULL,
  candidate_count SMALLINT UNSIGNED NOT NULL,
  stored_bytes BIGINT UNSIGNED NOT NULL,
  candidate_manifest_sha256 BINARY(32) NOT NULL,
  hold_snapshot_sha256 BINARY(32) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (run_id),
  KEY ix_retention_runs_board (board_pk, updated_at, run_id),
  CONSTRAINT fk_retention_runs_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_retention_runs_bounds CHECK (
    attempt BETWEEN 1 AND 65535
    AND candidate_count BETWEEN 0 AND 100
    AND stored_bytes BETWEEN 0 AND 33554432
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS board_retention_run_items (
  run_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  ordinal SMALLINT UNSIGNED NOT NULL,
  anchor_sha256 BINARY(32) NOT NULL,
  payload_sha256 BINARY(32) NOT NULL,
  stored_bytes INT UNSIGNED NOT NULL,
  hold_snapshot_sha256 BINARY(32) NOT NULL,
  phase ENUM('planned','refs_detached','payload_cleared','catalog_removed','complete','quarantined') NOT NULL,
  attempts SMALLINT UNSIGNED NOT NULL,
  last_error VARCHAR(1024) NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (run_id, revision_pk),
  UNIQUE KEY uq_retention_run_items_ordinal (run_id, ordinal),
  KEY ix_retention_run_items_phase (phase, updated_at, run_id),
  CONSTRAINT fk_retention_run_items_run FOREIGN KEY (run_id)
    REFERENCES board_retention_runs (run_id) ON DELETE RESTRICT,
  CONSTRAINT fk_retention_run_items_revision FOREIGN KEY (revision_pk)
    REFERENCES board_revisions (revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_retention_run_items_bounds CHECK (
    ordinal BETWEEN 1 AND 100
    AND stored_bytes BETWEEN 1 AND 33554432
    AND attempts BETWEEN 0 AND 10
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS board_retention_audit (
  run_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  fence BIGINT UNSIGNED NOT NULL,
  outcome ENUM('complete','quarantined') NOT NULL,
  completed_at DATETIME(3) NOT NULL,
  evidence_sha256 BINARY(32) NOT NULL,
  PRIMARY KEY (run_id, revision_pk, fence),
  KEY ix_retention_audit_completed (completed_at, run_id),
  CONSTRAINT fk_retention_audit_run FOREIGN KEY (run_id)
    REFERENCES board_retention_runs (run_id) ON DELETE RESTRICT,
  CONSTRAINT fk_retention_audit_revision FOREIGN KEY (revision_pk)
    REFERENCES board_revisions (revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_retention_audit_fence CHECK (
    fence BETWEEN 1 AND 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS retention_restore_drill_attempts (
  deployment_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_seq BIGINT UNSIGNED NOT NULL,
  registry_digest BINARY(32) NOT NULL,
  schema_projection_sha256 BINARY(32) NOT NULL,
  source_backup_sha256 BINARY(32) NOT NULL,
  isolation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quarantine_schema VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operator_principal VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at DATETIME(3) NOT NULL,
  restored_at DATETIME(3) NULL,
  certified_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  backup_ok TINYINT UNSIGNED NOT NULL,
  restore_ok TINYINT UNSIGNED NOT NULL,
  projection_ok TINYINT UNSIGNED NOT NULL,
  integrity_ok TINYINT UNSIGNED NOT NULL,
  evidence_sha256 BINARY(32) NOT NULL,
  signature BINARY(32) NOT NULL,
  PRIMARY KEY (deployment_id, attempt_seq),
  KEY ix_restore_drill_expiry (expires_at, deployment_id, attempt_seq),
  CONSTRAINT chk_restore_drill_sequence CHECK (
    attempt_seq BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_restore_drill_outcomes CHECK (
    backup_ok IN (0,1) AND restore_ok IN (0,1)
    AND projection_ok IN (0,1) AND integrity_ok IN (0,1)
  ),
  CONSTRAINT chk_restore_drill_expiry CHECK (
    expires_at = certified_at + INTERVAL 30 DAY
    AND started_at <= certified_at
    AND (restored_at IS NULL OR restored_at BETWEEN started_at AND certified_at)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE board_revisions
  DROP CHECK chk_revisions_codec,
  DROP CHECK chk_revisions_checkpoint,
  MODIFY COLUMN scene_schema_version CHAR(5) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY COLUMN scene_codec CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY COLUMN scene_payload LONGBLOB NULL,
  MODIFY COLUMN scene_canonical_bytes INT UNSIGNED NULL,
  MODIFY COLUMN scene_stored_bytes INT UNSIGNED NULL,
  MODIFY COLUMN scene_sha256 BINARY(32) NULL,
  ADD CONSTRAINT chk_revisions_retained_checkpoint
    CHECK (
      (
        scene_schema_version IS NULL
        AND scene_codec IS NULL
        AND scene_payload IS NULL
        AND scene_canonical_bytes IS NULL
        AND scene_stored_bytes IS NULL
        AND scene_sha256 IS NULL
      )
      OR
      (
        scene_schema_version IS NOT NULL
        AND scene_codec = 'B'
        AND scene_payload IS NOT NULL
        AND scene_canonical_bytes IS NOT NULL
        AND scene_stored_bytes = OCTET_LENGTH(scene_payload)
        AND scene_sha256 IS NOT NULL
        AND (
          (
            scene_schema_version = '1.0.0'
            AND scene_canonical_bytes BETWEEN 1 AND 786432
            AND scene_stored_bytes BETWEEN 1 AND 800000
          )
          OR
          (
            scene_schema_version = '2.0.0'
            AND scene_canonical_bytes BETWEEN 1 AND 20971520
            AND scene_stored_bytes BETWEEN 1 AND 33554432
          )
        )
      )
    );
