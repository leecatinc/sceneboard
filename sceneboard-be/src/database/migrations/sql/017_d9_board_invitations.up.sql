ALTER TABLE boards
  ADD COLUMN capability_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER archived_by_grant_id,
  ADD CONSTRAINT chk_boards_capability_epoch
    CHECK (capability_epoch BETWEEN 0 AND 9007199254740991);

ALTER TABLE users
  ADD COLUMN display_name VARCHAR(100) CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_as_ci NULL AFTER email,
  ADD COLUMN email_verified_at DATETIME(3) NULL AFTER display_name;

UPDATE users
SET display_name = LEFT(SUBSTRING_INDEX(email_normalized, '@', 1), 100),
    email_verified_at = created_at
WHERE display_name IS NULL OR email_verified_at IS NULL;

ALTER TABLE users
  MODIFY COLUMN display_name VARCHAR(100) CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_as_ci NOT NULL,
  MODIFY COLUMN email_verified_at DATETIME(3) NOT NULL,
  ADD KEY ix_users_verified_display_name (display_name, status, id),
  ADD CONSTRAINT chk_users_display_name CHECK (
    CHAR_LENGTH(display_name) BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT chk_users_email_verified_time CHECK (
    email_verified_at >= created_at
  );

CREATE TABLE board_invitations (
  invitation_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role ENUM('editor','viewer') NOT NULL,
  state ENUM('pending','accepted','revoked','expired','superseded') NOT NULL,
  token_locator BINARY(16) NOT NULL,
  token_digest BINARY(32) NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  invited_by_account_pk BIGINT UNSIGNED NOT NULL,
  accepted_account_pk BIGINT UNSIGNED NULL,
  superseded_by_invitation_pk BIGINT UNSIGNED NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  accepted_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  superseded_at DATETIME(3) NULL,
  active_email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN state = 'pending' THEN email_normalized ELSE NULL END
    ) STORED,
  PRIMARY KEY (invitation_pk),
  UNIQUE KEY uq_board_invitations_public_id (public_id),
  UNIQUE KEY uq_board_invitations_token_locator (token_locator),
  UNIQUE KEY uq_board_invitations_token_digest (token_digest),
  UNIQUE KEY uq_board_invitations_active_email (board_pk, active_email_normalized),
  KEY ix_board_invitations_board_state (board_pk, state, invitation_pk),
  KEY ix_board_invitations_email_state (email_normalized, state, expires_at),
  KEY ix_board_invitations_accepted_account (accepted_account_pk, state),
  CONSTRAINT fk_board_invitations_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_board_invitations_inviter FOREIGN KEY (invited_by_account_pk)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_board_invitations_accepted_account FOREIGN KEY (accepted_account_pk)
    REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_board_invitations_superseded_by FOREIGN KEY (superseded_by_invitation_pk)
    REFERENCES board_invitations (invitation_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_board_invitations_version CHECK (
    version BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_board_invitations_email CHECK (
    email_normalized = LOWER(email_normalized)
    AND OCTET_LENGTH(email_normalized) BETWEEN 5 AND 254
  ),
  CONSTRAINT chk_board_invitations_time CHECK (
    updated_at >= created_at AND expires_at > created_at
  ),
  CONSTRAINT chk_board_invitations_terminal CHECK (
    (state = 'pending' AND accepted_account_pk IS NULL
      AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL
      AND superseded_by_invitation_pk IS NULL)
    OR (state = 'accepted' AND accepted_account_pk IS NOT NULL
      AND accepted_at IS NOT NULL AND revoked_at IS NULL AND superseded_at IS NULL
      AND superseded_by_invitation_pk IS NULL)
    OR (state = 'revoked' AND accepted_account_pk IS NULL
      AND accepted_at IS NULL AND revoked_at IS NOT NULL AND superseded_at IS NULL
      AND superseded_by_invitation_pk IS NULL)
    OR (state = 'expired' AND accepted_account_pk IS NULL
      AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL
      AND superseded_by_invitation_pk IS NULL)
    OR (state = 'superseded' AND accepted_account_pk IS NULL
      AND accepted_at IS NULL AND revoked_at IS NULL AND superseded_at IS NOT NULL
      AND superseded_by_invitation_pk IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
