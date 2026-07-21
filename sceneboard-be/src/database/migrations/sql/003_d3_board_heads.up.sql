CREATE TABLE board_heads (
  board_pk BIGINT UNSIGNED NOT NULL,
  head_revision_pk BIGINT UNSIGNED NOT NULL,
  head_revision_number BIGINT UNSIGNED NOT NULL,
  last_event_sequence BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_pk),
  KEY ix_heads_revision_tuple (board_pk, head_revision_pk, head_revision_number),
  CONSTRAINT fk_heads_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_heads_revision FOREIGN KEY (board_pk, head_revision_pk, head_revision_number)
    REFERENCES board_revisions (board_pk, revision_pk, revision_number) ON DELETE RESTRICT,
  CONSTRAINT chk_heads_sequence CHECK (
    last_event_sequence BETWEEN 0 AND 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
