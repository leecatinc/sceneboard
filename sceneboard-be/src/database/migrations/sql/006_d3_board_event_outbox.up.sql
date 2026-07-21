CREATE TABLE board_event_outbox (
  event_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id BINARY(16) NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NULL,
  sequence_number BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision_created_pk BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN event_type = 'board.revision.created' THEN revision_pk ELSE NULL END
  ) STORED,
  event_payload MEDIUMBLOB NOT NULL,
  event_canonical_bytes INT UNSIGNED NOT NULL,
  event_sha256 BINARY(32) NOT NULL,
  status_code CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  delivered_at DATETIME(3) NULL,
  retain_until DATETIME(3) NULL,
  PRIMARY KEY (event_pk),
  UNIQUE KEY uq_outbox_event_id (event_id),
  UNIQUE KEY uq_outbox_board_sequence (board_pk, sequence_number),
  UNIQUE KEY uq_outbox_revision_created (revision_created_pk),
  KEY ix_outbox_pending (status_code, event_pk),
  KEY ix_outbox_revision_board (board_pk, revision_pk),
  CONSTRAINT fk_outbox_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_outbox_revision FOREIGN KEY (board_pk, revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_outbox_sequence CHECK (sequence_number BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_outbox_event_type CHECK (event_type IN (
    'board.snapshot','board.revision.created','hitl.updated',
    'artifact.status.changed','presence.updated','stream.resync.required',
    'stream.heartbeat','stream.error'
  )),
  CONSTRAINT chk_outbox_payload CHECK (
    event_canonical_bytes BETWEEN 1 AND 1048576
    AND event_canonical_bytes = OCTET_LENGTH(event_payload)
  ),
  CONSTRAINT chk_outbox_status CHECK (
    (status_code = 'P' AND delivered_at IS NULL AND retain_until IS NULL)
    OR
    (status_code = 'D' AND delivered_at IS NOT NULL
      AND retain_until IS NOT NULL AND retain_until > delivered_at)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
