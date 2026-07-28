ALTER TABLE share_transition_recovery
  MODIFY operation ENUM(
    'create','republish','update','rotate','revoke','archive',
    'password.enable','password.regenerate','password.disable'
  ) NOT NULL;

ALTER TABLE share_request_idempotency
  MODIFY operation ENUM(
    'create','republish','update','rotate','revoke',
    'password.enable','password.regenerate','password.disable'
  ) NOT NULL,
  MODIFY result_kind ENUM(
    'created','republished','updated','unchanged','rotated','revoked',
    'password-enabled','password-regenerated','password-disabled'
  ) NOT NULL;

CREATE TABLE IF NOT EXISTS share_password_credentials (
  share_pk BIGINT UNSIGNED NOT NULL,
  password_hash BINARY(32) NOT NULL,
  salt BINARY(16) NOT NULL,
  hash_version CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pepper_version SMALLINT UNSIGNED NOT NULL,
  credential_version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (share_pk),
  KEY ix_share_password_credentials_pepper (pepper_version, share_pk),
  CONSTRAINT fk_share_password_credentials_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_share_password_credentials_hash_version CHECK (hash_version = 'S1'),
  CONSTRAINT chk_share_password_credentials_version CHECK (
    credential_version BETWEEN 1 AND 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_password_session_families (
  family_digest BINARY(32) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (family_digest),
  KEY ix_share_password_families_expiry (expires_at, family_digest),
  CONSTRAINT chk_share_password_family_expiry CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_password_session_grants (
  family_digest BINARY(32) NOT NULL,
  share_pk BIGINT UNSIGNED NOT NULL,
  access_generation BIGINT UNSIGNED NOT NULL,
  credential_version BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (family_digest, share_pk),
  KEY ix_share_password_grants_share (share_pk, access_generation),
  KEY ix_share_password_grants_expiry (expires_at, family_digest, share_pk),
  CONSTRAINT fk_share_password_grants_family FOREIGN KEY (family_digest)
    REFERENCES share_password_session_families (family_digest) ON DELETE CASCADE,
  CONSTRAINT fk_share_password_grants_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_share_password_grant_generations CHECK (
    access_generation BETWEEN 1 AND 9007199254740991
    AND credential_version BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_share_password_grant_expiry CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_password_cleanup_leases (
  name VARBINARY(64) NOT NULL,
  lease_owner VARBINARY(64) NULL,
  lease_expires_at DATETIME(6) NULL,
  fence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (name),
  CONSTRAINT chk_share_password_cleanup_lease CHECK (
    fence BETWEEN 0 AND 9007199254740991
    AND (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO share_password_cleanup_leases (
  name, lease_owner, lease_expires_at, fence
) VALUES (
  _binary 'share-password-sessions', NULL, NULL, 0
) ON DUPLICATE KEY UPDATE name = VALUES(name);
