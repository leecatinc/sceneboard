CREATE TABLE IF NOT EXISTS board_memberships (
  membership_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  account_pk BIGINT UNSIGNED NOT NULL,
  role ENUM('owner','editor','viewer') NOT NULL,
  state ENUM('active','inactive') NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  owner_account_pk BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (membership_pk),
  UNIQUE KEY uq_board_memberships_public_id (public_id),
  UNIQUE KEY uq_board_memberships_account (board_pk, account_pk),
  UNIQUE KEY uq_board_memberships_owner (board_pk, owner_account_pk),
  KEY ix_board_memberships_active_account (account_pk, state, board_pk),
  KEY ix_board_memberships_board_role (board_pk, state, role, account_pk),
  CONSTRAINT fk_board_memberships_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_board_memberships_account FOREIGN KEY (account_pk)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_board_memberships_owner_account FOREIGN KEY (owner_account_pk)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT chk_board_memberships_role CHECK (
    role IN ('owner','editor','viewer')
  ),
  CONSTRAINT chk_board_memberships_state CHECK (
    state IN ('active','inactive')
  ),
  CONSTRAINT chk_board_memberships_version CHECK (
    version BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_board_memberships_owner_projection CHECK (
    (
      role = 'owner'
      AND state = 'active'
      AND owner_account_pk = account_pk
    )
    OR (
      role IN ('editor','viewer')
      AND owner_account_pk IS NULL
    )
  ),
  CONSTRAINT chk_board_memberships_time CHECK (
    updated_at >= created_at
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO board_memberships (
  public_id, board_pk, account_pk, role, state, version,
  owner_account_pk, created_at, updated_at
)
SELECT
  CONCAT('membership_owner_', b.board_pk),
  b.board_pk,
  b.owner_user_id,
  'owner',
  'active',
  1,
  b.owner_user_id,
  b.created_at,
  GREATEST(b.created_at, b.updated_at)
FROM boards b
ON DUPLICATE KEY UPDATE
  public_id = VALUES(public_id),
  role = 'owner',
  state = 'active',
  owner_account_pk = VALUES(owner_account_pk),
  version = GREATEST(board_memberships.version, VALUES(version)),
  updated_at = GREATEST(board_memberships.updated_at, VALUES(updated_at));
