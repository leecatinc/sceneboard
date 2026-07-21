CREATE TABLE boards (
  board_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(200) NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  created_by_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  archived_at DATETIME(3) NULL,
  archived_by_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NULL,
  archived_by_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  archived_by_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (board_pk),
  UNIQUE KEY uq_boards_public_id (public_id),
  KEY ix_boards_owner_created (
    owner_user_id, created_at DESC, board_pk DESC, archived_at
  ),
  CONSTRAINT fk_boards_owner_user FOREIGN KEY (owner_user_id)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_boards_title CHECK (CHAR_LENGTH(title) BETWEEN 1 AND 200),
  CONSTRAINT chk_boards_created_kind CHECK (created_by_kind IN ('U','M','S')),
  CONSTRAINT chk_boards_created_grant CHECK (
    (created_by_kind = 'M' AND created_by_grant_id IS NOT NULL)
    OR (created_by_kind IN ('U','S') AND created_by_grant_id IS NULL)
  ),
  CONSTRAINT chk_boards_archive_actor CHECK (
    (archived_at IS NULL AND archived_by_kind IS NULL
      AND archived_by_principal_id IS NULL AND archived_by_grant_id IS NULL)
    OR
    (archived_at IS NOT NULL AND archived_by_kind IN ('U','M','S')
      AND archived_by_principal_id IS NOT NULL
      AND ((archived_by_kind = 'M' AND archived_by_grant_id IS NOT NULL)
        OR (archived_by_kind IN ('U','S') AND archived_by_grant_id IS NULL)))
  ),
  CONSTRAINT chk_boards_time_order CHECK (
    updated_at >= created_at AND (archived_at IS NULL OR archived_at >= created_at)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
