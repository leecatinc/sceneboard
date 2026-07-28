ALTER TABLE board_revision_recovery
  ADD UNIQUE KEY uq_revision_recovery_identity (
    recovery_id, board_pk, revision_pk
  );

CREATE TABLE board_shares (
  share_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  share_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  status ENUM('active','revoked','archived') NOT NULL,
  access_policy ENUM('L','P') NOT NULL,
  pinned_revision_pk BIGINT UNSIGNED NOT NULL,
  publication_generation BIGINT UNSIGNED NOT NULL,
  access_generation BIGINT UNSIGNED NOT NULL,
  token_digest BINARY(32) NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (share_pk),
  UNIQUE KEY uq_board_shares_share_id (share_id),
  UNIQUE KEY uq_board_shares_board (board_pk),
  UNIQUE KEY uq_board_shares_token_digest (token_digest),
  KEY ix_board_shares_revision (board_pk, pinned_revision_pk, status),
  CONSTRAINT fk_board_shares_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_board_shares_revision FOREIGN KEY (board_pk, pinned_revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_board_shares_generations CHECK (
    publication_generation BETWEEN 1 AND 9007199254740991
    AND access_generation BETWEEN 1 AND 9007199254740991
    AND version BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_board_shares_access_policy CHECK (access_policy IN ('L','P')),
  CONSTRAINT chk_board_shares_status CHECK (status IN ('active','revoked','archived')),
  CONSTRAINT chk_board_shares_time CHECK (updated_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE share_transition_recovery (
  recovery_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  share_pk BIGINT UNSIGNED NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  operation ENUM('create','republish','update','rotate','revoke','archive') NOT NULL,
  fingerprint_sha256 BINARY(32) NOT NULL,
  before_sha256 BINARY(32) NOT NULL,
  after_sha256 BINARY(32) NOT NULL,
  old_revision_pk BIGINT UNSIGNED NULL,
  new_revision_pk BIGINT UNSIGNED NULL,
  credential_present TINYINT UNSIGNED NOT NULL DEFAULT 0,
  credential_version BIGINT UNSIGNED NULL,
  password_hash_sha256 BINARY(32) NULL,
  pepper_version SMALLINT UNSIGNED NULL,
  phase ENUM('planned','core_applied','complete','quarantined') NOT NULL,
  outcome ENUM('committed','aborted') NULL,
  lease_owner VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at DATETIME(3) NULL,
  operator_fence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  operator_claimant VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  operator_evidence_sha256 BINARY(32) NULL,
  attempts TINYINT UNSIGNED NOT NULL,
  last_error VARCHAR(1024) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  active_board_pk BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN phase <> 'complete' THEN board_pk ELSE NULL END
  ) STORED,
  PRIMARY KEY (recovery_id),
  UNIQUE KEY uq_share_transition_recovery_active_board (active_board_pk),
  KEY ix_share_transition_recovery_scan (phase, lease_expires_at, recovery_id),
  KEY ix_share_transition_recovery_board (board_pk, phase, updated_at),
  KEY ix_share_transition_recovery_share (share_pk, phase, recovery_id),
  CONSTRAINT fk_share_transition_recovery_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_share_transition_recovery_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_share_transition_recovery_old_revision FOREIGN KEY (board_pk, old_revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_share_transition_recovery_new_revision FOREIGN KEY (board_pk, new_revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_share_transition_recovery_phase CHECK (
    phase IN ('planned','core_applied','complete','quarantined')
  ),
  CONSTRAINT chk_share_transition_recovery_outcome CHECK (
    (phase = 'complete' AND outcome IS NOT NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (phase <> 'complete' AND outcome IS NULL)
  ),
  CONSTRAINT chk_share_transition_recovery_lease CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT chk_share_transition_recovery_attempts CHECK (attempts BETWEEN 0 AND 10),
  CONSTRAINT chk_share_transition_recovery_operator CHECK (
    operator_fence BETWEEN 0 AND 9007199254740991
    AND (
      (operator_claimant IS NULL AND operator_evidence_sha256 IS NULL)
      OR (operator_claimant IS NOT NULL AND operator_evidence_sha256 IS NOT NULL)
    )
  ),
  CONSTRAINT chk_share_transition_recovery_revision CHECK (
    old_revision_pk IS NOT NULL OR new_revision_pk IS NOT NULL
  ),
  CONSTRAINT chk_share_transition_recovery_credential_marker CHECK (
    (credential_present = 0 AND credential_version IS NULL
      AND password_hash_sha256 IS NULL AND pepper_version IS NULL)
    OR
    (credential_present = 1 AND credential_version BETWEEN 1 AND 9007199254740991
      AND password_hash_sha256 IS NOT NULL AND pepper_version IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE share_transition_recovery_items (
  discovery_recovery_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  share_transition_recovery_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (discovery_recovery_id),
  UNIQUE KEY uq_share_transition_item_revision (
    share_transition_recovery_id, board_pk, revision_pk
  ),
  KEY ix_share_transition_item_transition (
    share_transition_recovery_id, discovery_recovery_id
  ),
  CONSTRAINT fk_share_transition_item_discovery FOREIGN KEY (
    discovery_recovery_id, board_pk, revision_pk
  ) REFERENCES board_revision_recovery (
    recovery_id, board_pk, revision_pk
  ) ON DELETE RESTRICT,
  CONSTRAINT fk_share_transition_item_transition FOREIGN KEY (share_transition_recovery_id)
    REFERENCES share_transition_recovery (recovery_id) ON DELETE RESTRICT,
  CONSTRAINT fk_share_transition_item_revision FOREIGN KEY (board_pk, revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE share_request_idempotency (
  idempotency_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_pk BIGINT UNSIGNED NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  operation ENUM('create','republish','update','rotate','revoke') NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint_sha256 BINARY(32) NOT NULL,
  result_kind ENUM(
    'created','republished','updated','unchanged','rotated','revoked'
  ) NOT NULL,
  result_json_sha256 BINARY(32) NOT NULL,
  result_json JSON NOT NULL,
  share_pk BIGINT UNSIGNED NOT NULL,
  recovery_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (idempotency_pk),
  UNIQUE KEY uq_share_request_idempotency (
    account_pk, board_pk, operation, idempotency_key
  ),
  KEY ix_share_request_idempotency_board (board_pk, created_at, idempotency_pk),
  CONSTRAINT fk_share_request_idempotency_account FOREIGN KEY (account_pk)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_share_request_idempotency_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_share_request_idempotency_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_share_request_idempotency_recovery FOREIGN KEY (recovery_id)
    REFERENCES share_transition_recovery (recovery_id) ON DELETE RESTRICT,
  CONSTRAINT chk_share_request_idempotency_result CHECK (
    JSON_VALID(result_json) AND OCTET_LENGTH(result_json) BETWEEN 2 AND 16384
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
