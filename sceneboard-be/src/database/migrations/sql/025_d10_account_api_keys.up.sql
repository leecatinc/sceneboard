CREATE TABLE account_api_keys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  token_version TINYINT UNSIGNED NOT NULL DEFAULT 1,
  token_locator BINARY(16) NOT NULL,
  token_hash BINARY(32) NOT NULL,
  scope_mask BIGINT UNSIGNED NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL DEFAULT NULL,
  revoked_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_account_api_key_public_id (public_id),
  UNIQUE KEY uq_account_api_key_token_locator (token_locator),
  KEY ix_account_api_key_owner_list (owner_user_id, created_at DESC, id DESC, status),
  KEY ix_account_api_key_expiry (status, expires_at, id),
  CONSTRAINT fk_account_api_key_owner FOREIGN KEY (owner_user_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_account_api_key_public_id CHECK (
    REGEXP_LIKE(public_id, '^[A-Za-z0-9_-]{1,128}$', 'c')
  ),
  CONSTRAINT chk_account_api_key_display_name CHECK (
    display_name = TRIM(display_name) AND CHAR_LENGTH(display_name) BETWEEN 1 AND 80
  ),
  CONSTRAINT chk_account_api_key_token_version CHECK (token_version = 1),
  CONSTRAINT chk_account_api_key_scope_mask CHECK (scope_mask BETWEEN 1 AND 63),
  CONSTRAINT chk_account_api_key_status CHECK (status IN (1, 2)),
  CONSTRAINT chk_account_api_key_times CHECK (
    created_at < expires_at
    AND (last_used_at IS NULL OR last_used_at >= created_at)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  ),
  CONSTRAINT chk_account_api_key_terminal CHECK (
    (status = 1 AND revoked_at IS NULL) OR (status = 2 AND revoked_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
