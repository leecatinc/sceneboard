CREATE TABLE board_artifact_capability_policy_epochs (
  board_pk BIGINT UNSIGNED NOT NULL,
  owner_user_pk BIGINT UNSIGNED NOT NULL,
  policy_epoch BINARY(16) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_pk),
  UNIQUE KEY uq_artifact_policy_epoch (policy_epoch),
  CONSTRAINT fk_artifact_policy_epoch_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_artifact_policy_epoch_owner FOREIGN KEY (owner_user_pk)
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE board_artifact_capability_policies (
  board_pk BIGINT UNSIGNED NOT NULL,
  owner_user_pk BIGINT UNSIGNED NOT NULL,
  capability VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  approved_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_pk, capability),
  CONSTRAINT fk_artifact_policy_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_artifact_policy_owner FOREIGN KEY (owner_user_pk)
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE artifact_capability_preauthorization_tickets (
  ticket_digest BINARY(32) NOT NULL,
  owner_user_pk BIGINT UNSIGNED NOT NULL,
  session_pk BIGINT UNSIGNED NULL,
  grant_pk BIGINT UNSIGNED NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  artifact_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capability VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_digest BINARY(32) NOT NULL,
  policy_epoch BINARY(16) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (ticket_digest),
  KEY ix_artifact_tickets_active_expiry (consumed_at, expires_at, ticket_digest),
  KEY ix_artifact_tickets_board_epoch (board_pk, policy_epoch, consumed_at, expires_at),
  CONSTRAINT fk_artifact_ticket_owner FOREIGN KEY (owner_user_pk)
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_artifact_ticket_session FOREIGN KEY (session_pk)
    REFERENCES auth_sessions (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_artifact_ticket_grant FOREIGN KEY (grant_pk)
    REFERENCES mcp_grants (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_artifact_ticket_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_artifact_ticket_principal CHECK (
    (session_pk IS NOT NULL AND grant_pk IS NULL)
    OR (session_pk IS NULL AND grant_pk IS NOT NULL)
  ),
  CONSTRAINT ck_artifact_ticket_capability CHECK (
    capability IN ('clipboard.write','download','fullscreen')
  ),
  CONSTRAINT ck_artifact_ticket_consumed CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT ck_artifact_ticket_expiry CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
