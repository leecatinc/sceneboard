CREATE TABLE media_cleanup_runs (
  run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lease_owner VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fence BIGINT UNSIGNED NOT NULL,
  lease_expires_at DATETIME(3) NOT NULL,
  state ENUM('running','complete','quarantined') NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (run_id),
  KEY ix_media_cleanup_runs_lease (state, lease_expires_at, run_id),
  CONSTRAINT chk_media_cleanup_runs_fence CHECK (fence BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_media_cleanup_runs_attempts CHECK (attempts BETWEEN 0 AND 10),
  CONSTRAINT chk_media_cleanup_runs_time CHECK (updated_at >= started_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE media_cleanup_items (
  cleanup_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  board_media_pk BIGINT UNSIGNED NOT NULL,
  media_pk BIGINT UNSIGNED NOT NULL,
  expected_board_media_version BIGINT UNSIGNED NOT NULL,
  expected_object_version BIGINT UNSIGNED NOT NULL,
  phase ENUM(
    'intent',
    'ownership_quarantined',
    'refs_rechecked',
    'ownership_released',
    'object_quarantined',
    'object_deleted',
    'complete',
    'quarantined'
  ) NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(1024) NULL,
  ownership_quarantined_at DATETIME(3) NULL,
  object_quarantined_at DATETIME(3) NULL,
  delete_after DATETIME(3) NULL,
  ref_snapshot_sha256 BINARY(32) NOT NULL,
  hold_snapshot_sha256 BINARY(32) NOT NULL,
  ownership_snapshot_sha256 BINARY(32) NOT NULL,
  backup_deployment_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  backup_attempt_seq BIGINT UNSIGNED NULL,
  backup_manifest_sha256 BINARY(32) NULL,
  object_sha256 BINARY(32) NOT NULL,
  byte_length INT UNSIGNED NOT NULL,
  completion_evidence_sha256 BINARY(32) NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (cleanup_id),
  UNIQUE KEY uq_media_cleanup_item_ownership (run_id, board_media_pk),
  KEY ix_media_cleanup_items_phase (phase, updated_at, cleanup_id),
  KEY ix_media_cleanup_items_object (media_pk, phase, cleanup_id),
  CONSTRAINT fk_media_cleanup_items_run FOREIGN KEY (run_id)
    REFERENCES media_cleanup_runs (run_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_media_cleanup_items_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_media_cleanup_items_attempts CHECK (attempts BETWEEN 0 AND 10),
  CONSTRAINT chk_media_cleanup_items_versions CHECK (
    expected_board_media_version >= 1 AND expected_object_version >= 1
  ),
  CONSTRAINT chk_media_cleanup_items_bytes CHECK (byte_length BETWEEN 1 AND 10485760),
  CONSTRAINT chk_media_cleanup_items_deadline CHECK (
    (object_quarantined_at IS NULL AND delete_after IS NULL)
    OR delete_after = object_quarantined_at + INTERVAL 7 DAY
  ),
  CONSTRAINT chk_media_cleanup_items_backup CHECK (
    (backup_deployment_id IS NULL AND backup_attempt_seq IS NULL AND backup_manifest_sha256 IS NULL)
    OR
    (backup_deployment_id IS NOT NULL
      AND backup_attempt_seq BETWEEN 1 AND 9007199254740991
      AND backup_manifest_sha256 IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE media_backup_certificates (
  deployment_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_seq BIGINT UNSIGNED NOT NULL,
  source_backup_sha256 BINARY(32) NOT NULL,
  media_manifest_sha256 BINARY(32) NOT NULL,
  certified_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  backup_ok TINYINT UNSIGNED NOT NULL,
  restore_ok TINYINT UNSIGNED NOT NULL,
  integrity_ok TINYINT UNSIGNED NOT NULL,
  signature BINARY(32) NOT NULL,
  PRIMARY KEY (deployment_id, attempt_seq),
  KEY ix_media_backup_certificates_expiry (expires_at, deployment_id, attempt_seq),
  CONSTRAINT chk_media_backup_certificate_sequence CHECK (
    attempt_seq BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_media_backup_certificate_outcomes CHECK (
    backup_ok IN (0,1) AND restore_ok IN (0,1) AND integrity_ok IN (0,1)
  ),
  CONSTRAINT chk_media_backup_certificate_expiry CHECK (
    expires_at > certified_at
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE media_backup_certificate_objects (
  deployment_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_seq BIGINT UNSIGNED NOT NULL,
  media_pk BIGINT UNSIGNED NOT NULL,
  object_version BIGINT UNSIGNED NOT NULL,
  sha256 BINARY(32) NOT NULL,
  byte_length INT UNSIGNED NOT NULL,
  PRIMARY KEY (deployment_id, attempt_seq, media_pk),
  KEY ix_media_backup_certificate_objects_media (
    media_pk, object_version, deployment_id, attempt_seq
  ),
  CONSTRAINT fk_media_backup_certificate_objects_certificate FOREIGN KEY (
    deployment_id, attempt_seq
  ) REFERENCES media_backup_certificates (
    deployment_id, attempt_seq
  ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_media_backup_certificate_object_version CHECK (object_version >= 1),
  CONSTRAINT chk_media_backup_certificate_object_bytes CHECK (
    byte_length BETWEEN 1 AND 10485760
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
