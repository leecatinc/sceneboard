CREATE TABLE media_objects (
  media_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sha256 BINARY(32) NOT NULL,
  bytes LONGBLOB NOT NULL,
  mime ENUM('image/png','image/jpeg','image/webp') NOT NULL,
  width INT UNSIGNED NOT NULL,
  height INT UNSIGNED NOT NULL,
  byte_length INT UNSIGNED NOT NULL,
  state ENUM('active','quarantined') NOT NULL DEFAULT 'active',
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (media_pk),
  UNIQUE KEY uq_media_objects_sha256 (sha256),
  CONSTRAINT chk_media_objects_dimensions CHECK (width BETWEEN 1 AND 16384 AND height BETWEEN 1 AND 16384),
  CONSTRAINT chk_media_objects_byte_length CHECK (byte_length BETWEEN 1 AND 10485760),
  CONSTRAINT chk_media_objects_octets CHECK (OCTET_LENGTH(bytes) = byte_length),
  CONSTRAINT chk_media_objects_version CHECK (version >= 1)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE board_media (
  board_media_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  board_pk BIGINT UNSIGNED NOT NULL,
  media_pk BIGINT UNSIGNED NOT NULL,
  media_id VARBINARY(128) NOT NULL,
  status ENUM('active','quarantined','released') NOT NULL DEFAULT 'active',
  lease_expires_at DATETIME(3) NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_media_pk),
  UNIQUE KEY uq_board_media_public_id (media_id),
  UNIQUE KEY uq_board_media_object (board_pk, media_pk),
  KEY ix_board_media_lease (board_pk, status, lease_expires_at),
  KEY ix_board_media_object_status (media_pk, status),
  CONSTRAINT fk_board_media_board FOREIGN KEY (board_pk) REFERENCES boards (board_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_board_media_object FOREIGN KEY (media_pk) REFERENCES media_objects (media_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_board_media_id CHECK (OCTET_LENGTH(media_id) BETWEEN 1 AND 128),
  CONSTRAINT chk_board_media_version CHECK (version >= 1)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE board_media_quota (
  board_pk BIGINT UNSIGNED NOT NULL,
  used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_pk),
  CONSTRAINT fk_board_media_quota_board FOREIGN KEY (board_pk) REFERENCES boards (board_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_board_media_quota_used CHECK (used_bytes <= 536870912),
  CONSTRAINT chk_board_media_quota_version CHECK (version >= 1)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE media_ingest_idempotency (
  account_pk BIGINT UNSIGNED NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  idempotency_key VARBINARY(128) NOT NULL,
  fingerprint_sha256 BINARY(32) NOT NULL,
  result_kind ENUM('active','expired') NOT NULL,
  result_json JSON NOT NULL,
  result_sha256 BINARY(32) NOT NULL,
  board_media_pk BIGINT UNSIGNED NULL,
  recovery_id VARBINARY(128) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (account_pk, board_pk, idempotency_key),
  KEY ix_media_ingest_ownership (board_media_pk, result_kind),
  CONSTRAINT fk_media_ingest_account FOREIGN KEY (account_pk) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_media_ingest_board FOREIGN KEY (board_pk) REFERENCES boards (board_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_media_ingest_ownership FOREIGN KEY (board_media_pk) REFERENCES board_media (board_media_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_media_ingest_key CHECK (OCTET_LENGTH(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT chk_media_ingest_recovery CHECK (recovery_id IS NULL OR OCTET_LENGTH(recovery_id) BETWEEN 1 AND 128)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
