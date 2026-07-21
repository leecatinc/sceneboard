CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  password_hash CHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  password_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_users_public_id UNIQUE (public_id),
  CONSTRAINT uq_users_email UNIQUE (email_normalized),
  CONSTRAINT ck_users_status CHECK (status IN (1, 2)),
  CONSTRAINT ck_users_public_id CHECK (REGEXP_LIKE(public_id, '^[A-Za-z0-9_-]{1,128}$', 'c')),
  CONSTRAINT ck_users_email_normalized CHECK (
    email_normalized = LOWER(email_normalized)
    AND OCTET_LENGTH(email_normalized) BETWEEN 5 AND 254
    AND email_normalized NOT LIKE '.%'
    AND email_normalized NOT LIKE '%.@%'
    AND email_normalized NOT LIKE '%..%'
    AND REGEXP_LIKE(email_normalized, '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$', 'c')
  ),
  CONSTRAINT ck_users_email_display CHECK (email = TRIM(email) AND LOWER(email) = email_normalized),
  CONSTRAINT ck_users_password_hash CHECK (OCTET_LENGTH(password_hash) = 60)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  family_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  token_locator BINARY(16) NOT NULL,
  token_hash BINARY(32) NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  rotated_from_id BIGINT UNSIGNED NULL DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  idle_expires_at DATETIME(3) NOT NULL,
  absolute_expires_at DATETIME(3) NOT NULL,
  rotated_at DATETIME(3) NULL DEFAULT NULL,
  revoked_at DATETIME(3) NULL DEFAULT NULL,
  revoke_reason TINYINT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_sessions_public_id UNIQUE (public_id),
  CONSTRAINT uq_sessions_token_locator UNIQUE (token_locator),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_auth_sessions_rotated_from FOREIGN KEY (rotated_from_id) REFERENCES auth_sessions (id) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT ck_auth_sessions_status CHECK (status IN (1, 2, 3, 4)),
  CONSTRAINT ck_auth_sessions_revoke_reason CHECK (revoke_reason IS NULL OR revoke_reason IN (1, 2, 3, 4, 5)),
  CONSTRAINT ck_auth_sessions_public_ids CHECK (
    REGEXP_LIKE(public_id, '^[A-Za-z0-9_-]{1,128}$', 'c')
    AND REGEXP_LIKE(family_public_id, '^[A-Za-z0-9_-]{1,128}$', 'c')
  ),
  CONSTRAINT ck_auth_sessions_expiry_order CHECK (created_at < idle_expires_at AND idle_expires_at <= absolute_expires_at),
  CONSTRAINT ck_auth_sessions_terminal_fields CHECK (
    (status = 1 AND rotated_at IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status = 2 AND rotated_at IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (status IN (3, 4) AND rotated_at IS NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  INDEX ix_sessions_family_status (family_public_id, status, idle_expires_at, absolute_expires_at, id),
  INDEX ix_sessions_user_status_expiry (user_id, status, absolute_expires_at),
  INDEX ix_sessions_status_absolute (status, absolute_expires_at, id),
  INDEX ix_sessions_status_rotated (status, rotated_at, id),
  INDEX ix_sessions_status_revoked (status, revoked_at, id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS security_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type SMALLINT UNSIGNED NOT NULL,
  outcome TINYINT UNSIGNED NOT NULL,
  actor_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL,
  user_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL,
  session_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL,
  client_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL,
  grant_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL,
  pairing_public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL,
  subject_fingerprint BINARY(32) NULL DEFAULT NULL,
  ip_prefix_hash BINARY(32) NULL DEFAULT NULL,
  user_agent_hash BINARY(32) NULL DEFAULT NULL,
  metadata JSON NULL DEFAULT NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT ck_security_audit_event_type CHECK (event_type BETWEEN 1 AND 65535),
  CONSTRAINT ck_security_audit_outcome CHECK (outcome IN (1, 2, 3, 4)),
  CONSTRAINT ck_security_audit_public_ids CHECK (
    (actor_public_id IS NULL OR REGEXP_LIKE(actor_public_id, '^[A-Za-z0-9_-]{1,128}$', 'c'))
    AND (user_public_id IS NULL OR REGEXP_LIKE(user_public_id, '^[A-Za-z0-9_-]{1,128}$', 'c'))
    AND (session_public_id IS NULL OR REGEXP_LIKE(session_public_id, '^[A-Za-z0-9_-]{1,128}$', 'c'))
    AND (client_public_id IS NULL OR REGEXP_LIKE(client_public_id, '^[A-Za-z0-9_-]{1,128}$', 'c'))
    AND (grant_public_id IS NULL OR REGEXP_LIKE(grant_public_id, '^[A-Za-z0-9_-]{1,128}$', 'c'))
    AND (pairing_public_id IS NULL OR REGEXP_LIKE(pairing_public_id, '^[A-Za-z0-9_-]{1,128}$', 'c'))
  ),
  CONSTRAINT ck_security_audit_metadata_size CHECK (metadata IS NULL OR OCTET_LENGTH(CAST(metadata AS CHAR)) <= 4096),
  INDEX ix_audit_occurred (occurred_at, id),
  INDEX ix_audit_actor_occurred (actor_public_id, occurred_at, id),
  INDEX ix_audit_session_occurred (session_public_id, occurred_at, id),
  INDEX ix_audit_grant_occurred (grant_public_id, occurred_at, id),
  INDEX ix_audit_event_occurred (event_type, occurred_at, id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
