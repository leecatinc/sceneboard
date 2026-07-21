CREATE TABLE mcp_clients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  installation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_clients_public_id UNIQUE (public_id),
  CONSTRAINT uq_clients_owner_installation UNIQUE (owner_user_id, installation_id),
  CONSTRAINT fk_mcp_clients_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_clients_public_id CHECK (REGEXP_LIKE(public_id, '^[A-Za-z0-9_-]{1,128}$', 'c')),
  CONSTRAINT ck_mcp_clients_installation CHECK (OCTET_LENGTH(installation_id) BETWEEN 16 AND 128),
  CONSTRAINT ck_mcp_clients_display_name CHECK (CHAR_LENGTH(display_name) BETWEEN 1 AND 100)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE mcp_grants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  source_session_id BIGINT UNSIGNED NULL DEFAULT NULL,
  scope_mask TINYINT UNSIGNED NOT NULL,
  lifecycle_mask TINYINT UNSIGNED NOT NULL DEFAULT 0,
  lifetime TINYINT UNSIGNED NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  expires_at DATETIME(3) NOT NULL,
  activated_at DATETIME(3) NULL DEFAULT NULL,
  last_used_at DATETIME(3) NULL DEFAULT NULL,
  revoked_at DATETIME(3) NULL DEFAULT NULL,
  revoke_reason TINYINT UNSIGNED NULL DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT uq_grants_public_id UNIQUE (public_id),
  CONSTRAINT fk_mcp_grants_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_mcp_grants_client FOREIGN KEY (client_id) REFERENCES mcp_clients (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_mcp_grants_source_session FOREIGN KEY (source_session_id) REFERENCES auth_sessions (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_grants_public_id CHECK (REGEXP_LIKE(public_id, '^[A-Za-z0-9_-]{1,128}$', 'c')),
  CONSTRAINT ck_mcp_grants_lifetime CHECK (lifetime IN (1, 2)),
  CONSTRAINT ck_mcp_grants_status CHECK (status IN (1, 2, 3, 4)),
  CONSTRAINT ck_mcp_grants_revoke_reason CHECK (revoke_reason IS NULL OR revoke_reason IN (1, 2, 3, 4)),
  CONSTRAINT ck_mcp_grants_masks CHECK (scope_mask BETWEEN 1 AND 127 AND lifecycle_mask BETWEEN 0 AND 3),
  CONSTRAINT ck_mcp_grants_session_source CHECK (
    (lifetime = 1 AND source_session_id IS NOT NULL)
    OR (lifetime = 2 AND source_session_id IS NULL)
  ),
  CONSTRAINT ck_mcp_grants_expiry CHECK (created_at < expires_at),
  CONSTRAINT ck_mcp_grants_state_fields CHECK (
    (status = 1 AND activated_at IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 2 AND activated_at IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status IN (3, 4) AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  INDEX ix_grants_owner_created (owner_user_id, created_at DESC, id DESC),
  INDEX ix_grants_client_status (client_id, status),
  INDEX ix_grants_source_session (source_session_id, status),
  INDEX ix_grants_status_expiry (status, expires_at, id),
  INDEX ix_grants_status_revoked (status, revoked_at, id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE pairing_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  source_session_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NULL DEFAULT NULL,
  code_locator_hash BINARY(32) NULL DEFAULT NULL,
  code_verifier_hash BINARY(32) NULL DEFAULT NULL,
  client_proof_challenge BINARY(32) NULL DEFAULT NULL,
  requested_scope_mask TINYINT UNSIGNED NOT NULL DEFAULT 0,
  requested_lifecycle_mask TINYINT UNSIGNED NOT NULL DEFAULT 0,
  approved_scope_mask TINYINT UNSIGNED NULL DEFAULT NULL,
  approved_lifecycle_mask TINYINT UNSIGNED NULL DEFAULT NULL,
  lifetime TINYINT UNSIGNED NULL DEFAULT NULL,
  state TINYINT UNSIGNED NOT NULL DEFAULT 1,
  matched_failure_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  code_expires_at DATETIME(3) NOT NULL,
  decision_expires_at DATETIME(3) NULL DEFAULT NULL,
  redeem_expires_at DATETIME(3) NULL DEFAULT NULL,
  claimed_at DATETIME(3) NULL DEFAULT NULL,
  decided_at DATETIME(3) NULL DEFAULT NULL,
  grant_id BIGINT UNSIGNED NULL DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT uq_pairing_public_id UNIQUE (public_id),
  CONSTRAINT uq_pairing_code_locator_hash UNIQUE (code_locator_hash),
  CONSTRAINT fk_pairing_requests_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_pairing_requests_source_session FOREIGN KEY (source_session_id) REFERENCES auth_sessions (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_pairing_requests_client FOREIGN KEY (client_id) REFERENCES mcp_clients (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_pairing_requests_grant FOREIGN KEY (grant_id) REFERENCES mcp_grants (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_pairing_public_id CHECK (REGEXP_LIKE(public_id, '^[A-Za-z0-9_-]{1,128}$', 'c')),
  CONSTRAINT ck_pairing_requests_state CHECK (state IN (1, 2, 3, 4, 5, 6, 7, 8)),
  CONSTRAINT ck_pairing_requests_lifetime CHECK (lifetime IS NULL OR lifetime IN (1, 2)),
  CONSTRAINT ck_pairing_scope_masks CHECK (
    requested_scope_mask BETWEEN 0 AND 127
    AND requested_lifecycle_mask BETWEEN 0 AND 3
    AND (approved_scope_mask IS NULL OR (
      approved_scope_mask BETWEEN 1 AND 127
      AND (approved_scope_mask & requested_scope_mask) = approved_scope_mask
    ))
    AND (approved_lifecycle_mask IS NULL OR (
      approved_lifecycle_mask BETWEEN 0 AND 3
      AND (approved_lifecycle_mask & requested_lifecycle_mask) = approved_lifecycle_mask
    ))
  ),
  CONSTRAINT ck_pairing_failures CHECK (matched_failure_count BETWEEN 0 AND 5),
  CONSTRAINT ck_pairing_deadlines CHECK (
    created_at < code_expires_at
    AND (decision_expires_at IS NULL OR claimed_at < decision_expires_at)
    AND (redeem_expires_at IS NULL OR decided_at < redeem_expires_at)
  ),
  CONSTRAINT ck_pairing_state_fields CHECK (
    (state = 1 AND code_locator_hash IS NOT NULL AND code_verifier_hash IS NOT NULL
      AND client_id IS NULL AND client_proof_challenge IS NULL
      AND requested_scope_mask = 0 AND requested_lifecycle_mask = 0
      AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
      AND claimed_at IS NULL AND decision_expires_at IS NULL AND decided_at IS NULL
      AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count BETWEEN 0 AND 4)
    OR
    (state = 2 AND code_locator_hash IS NULL AND code_verifier_hash IS NULL
      AND client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
      AND requested_scope_mask BETWEEN 1 AND 127 AND requested_lifecycle_mask BETWEEN 0 AND 3
      AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
      AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NULL
      AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count BETWEEN 0 AND 4)
    OR
    (state IN (3, 4) AND code_locator_hash IS NULL AND code_verifier_hash IS NULL
      AND client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
      AND requested_scope_mask BETWEEN 1 AND 127 AND requested_lifecycle_mask BETWEEN 0 AND 3
      AND approved_scope_mask BETWEEN 1 AND 127 AND approved_lifecycle_mask BETWEEN 0 AND 3 AND lifetime IN (1, 2)
      AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NOT NULL
      AND redeem_expires_at IS NOT NULL AND grant_id IS NOT NULL AND matched_failure_count BETWEEN 0 AND 4)
    OR
    (state = 5 AND code_locator_hash IS NULL AND code_verifier_hash IS NULL
      AND client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
      AND requested_scope_mask BETWEEN 1 AND 127 AND requested_lifecycle_mask BETWEEN 0 AND 3
      AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
      AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NOT NULL
      AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count BETWEEN 0 AND 4)
    OR
    (state IN (6, 7) AND code_locator_hash IS NULL AND code_verifier_hash IS NULL AND (
      (client_id IS NULL AND client_proof_challenge IS NULL
        AND requested_scope_mask = 0 AND requested_lifecycle_mask = 0
        AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
        AND claimed_at IS NULL AND decision_expires_at IS NULL AND decided_at IS NULL
        AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count BETWEEN 0 AND 4)
      OR
      (client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
        AND requested_scope_mask BETWEEN 1 AND 127 AND requested_lifecycle_mask BETWEEN 0 AND 3
        AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
        AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NULL
        AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count BETWEEN 0 AND 4)
      OR
      (client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
        AND requested_scope_mask BETWEEN 1 AND 127 AND requested_lifecycle_mask BETWEEN 0 AND 3
        AND approved_scope_mask BETWEEN 1 AND 127 AND approved_lifecycle_mask BETWEEN 0 AND 3 AND lifetime IN (1, 2)
        AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NOT NULL
        AND redeem_expires_at IS NOT NULL AND grant_id IS NOT NULL AND matched_failure_count BETWEEN 0 AND 4)
    ))
    OR
    (state = 8 AND code_locator_hash IS NULL AND code_verifier_hash IS NULL
      AND client_id IS NULL AND client_proof_challenge IS NULL
      AND requested_scope_mask = 0 AND requested_lifecycle_mask = 0
      AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
      AND claimed_at IS NULL AND decision_expires_at IS NULL AND decided_at IS NULL
      AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count = 5)
  ),
  INDEX ix_pairing_owner_state_created (owner_user_id, state, created_at, id),
  INDEX ix_pairing_source_session_state (source_session_id, state, grant_id),
  INDEX ix_pairing_state_code_expiry (state, code_expires_at, id),
  INDEX ix_pairing_state_decision_expiry (state, decision_expires_at, id),
  INDEX ix_pairing_state_redeem_expiry (state, redeem_expires_at, id),
  INDEX ix_pairing_state_updated (state, updated_at, id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE mcp_grant_credentials (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  grant_id BIGINT UNSIGNED NOT NULL,
  locator BINARY(16) NOT NULL,
  token_hash BINARY(32) NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  rotated_from_id BIGINT UNSIGNED NULL DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_grant_credentials_locator UNIQUE (locator),
  CONSTRAINT fk_mcp_grant_credentials_grant FOREIGN KEY (grant_id) REFERENCES mcp_grants (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_mcp_grant_credentials_rotated_from FOREIGN KEY (rotated_from_id) REFERENCES mcp_grant_credentials (id) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT ck_mcp_grant_credentials_status CHECK (status IN (1, 2, 3)),
  CONSTRAINT ck_mcp_grant_credentials_state_fields CHECK (
    (status = 1 AND revoked_at IS NULL)
    OR (status IN (2, 3) AND revoked_at IS NOT NULL)
  ),
  INDEX ix_grant_credentials_grant_status (grant_id, status),
  INDEX ix_grant_credentials_status_revoked (status, revoked_at, id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE mcp_grant_boards (
  grant_id BIGINT UNSIGNED NOT NULL,
  board_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (grant_id, board_public_id),
  CONSTRAINT fk_mcp_grant_boards_grant FOREIGN KEY (grant_id) REFERENCES mcp_grants (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_mcp_grant_boards_board_public_id FOREIGN KEY (board_public_id) REFERENCES boards (public_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  INDEX ix_grant_boards_board_grant (board_public_id, grant_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
