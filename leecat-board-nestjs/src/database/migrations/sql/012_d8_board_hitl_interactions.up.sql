CREATE TABLE board_hitl_interactions (
  hitl_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  board_pk BIGINT UNSIGNED NOT NULL,
  hitl_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  definition_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  definition_payload MEDIUMBLOB NOT NULL,
  definition_canonical_bytes INT UNSIGNED NOT NULL,
  definition_sha256 BINARY(32) NOT NULL,
  state_code CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NULL,
  response_payload MEDIUMBLOB NULL,
  response_canonical_bytes INT UNSIGNED NULL,
  response_sha256 BINARY(32) NULL,
  created_by_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  answered_by_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NULL,
  answered_by_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  answered_by_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  terminal_by_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NULL,
  terminal_by_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  terminal_by_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  superseded_by_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  answered_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_event_sequence BIGINT UNSIGNED NOT NULL,
  state_event_sequence BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  state_updated_at DATETIME(3) NOT NULL,
  answered_at DATETIME(3) NULL,
  PRIMARY KEY (hitl_pk),
  UNIQUE KEY uq_hitl_board_request (board_pk, hitl_request_id),
  KEY ix_hitl_due (state_code, expires_at, hitl_pk),
  KEY ix_hitl_successor (board_pk, superseded_by_request_id),
  CONSTRAINT fk_hitl_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_hitl_successor FOREIGN KEY (board_pk, superseded_by_request_id)
    REFERENCES board_hitl_interactions (board_pk, hitl_request_id) ON DELETE RESTRICT,
  CONSTRAINT chk_hitl_definition_kind CHECK (definition_kind IN ('I','H','F','C')),
  CONSTRAINT chk_hitl_state CHECK (state_code IN ('O','A','S','E','C')),
  CONSTRAINT chk_hitl_response_kind CHECK (response_kind IS NULL OR response_kind IN ('I','H','F','C')),
  CONSTRAINT chk_hitl_definition_bytes CHECK (
    definition_canonical_bytes BETWEEN 1 AND 1048576
    AND definition_canonical_bytes = OCTET_LENGTH(definition_payload)
  ),
  CONSTRAINT chk_hitl_response_bytes CHECK (
    (response_payload IS NULL AND response_kind IS NULL
      AND response_canonical_bytes IS NULL AND response_sha256 IS NULL)
    OR (response_payload IS NOT NULL AND response_kind IS NOT NULL
      AND response_canonical_bytes BETWEEN 1 AND 65536
      AND response_canonical_bytes = OCTET_LENGTH(response_payload)
      AND response_sha256 IS NOT NULL)
  ),
  CONSTRAINT chk_hitl_created_actor CHECK (
    created_by_kind IN ('U','M')
    AND ((created_by_kind = 'M' AND created_by_grant_id IS NOT NULL)
      OR (created_by_kind = 'U' AND created_by_grant_id IS NULL))
  ),
  CONSTRAINT chk_hitl_sequence CHECK (
    created_event_sequence BETWEEN 1 AND 9007199254740991
    AND state_event_sequence BETWEEN created_event_sequence AND 9007199254740991
  ),
  CONSTRAINT chk_hitl_expiry CHECK (expires_at > created_at),
  CONSTRAINT chk_hitl_state_shape CHECK (
    (state_code = 'O' AND response_payload IS NULL AND answered_at IS NULL
      AND answered_by_kind IS NULL AND answered_by_principal_id IS NULL
      AND answered_by_grant_id IS NULL AND terminal_by_kind IS NULL
      AND terminal_by_principal_id IS NULL AND terminal_by_grant_id IS NULL
      AND superseded_by_request_id IS NULL AND answered_request_id IS NULL
      AND state_updated_at = created_at AND state_event_sequence = created_event_sequence)
    OR (state_code = 'A' AND response_payload IS NOT NULL AND answered_at IS NOT NULL
      AND answered_at = state_updated_at AND answered_at > created_at AND answered_at < expires_at
      AND answered_by_kind IN ('U','M') AND answered_by_principal_id IS NOT NULL
      AND ((answered_by_kind = 'M' AND answered_by_grant_id IS NOT NULL)
        OR (answered_by_kind = 'U' AND answered_by_grant_id IS NULL))
      AND terminal_by_kind IS NULL AND terminal_by_principal_id IS NULL
      AND terminal_by_grant_id IS NULL AND superseded_by_request_id IS NULL
      AND answered_request_id IS NOT NULL AND state_event_sequence > created_event_sequence)
    OR (state_code = 'S' AND response_payload IS NULL AND answered_at IS NULL
      AND answered_by_kind IS NULL AND answered_by_principal_id IS NULL
      AND answered_by_grant_id IS NULL AND terminal_by_kind IN ('U','M')
      AND terminal_by_principal_id IS NOT NULL
      AND ((terminal_by_kind = 'M' AND terminal_by_grant_id IS NOT NULL)
        OR (terminal_by_kind = 'U' AND terminal_by_grant_id IS NULL))
      AND superseded_by_request_id IS NOT NULL AND answered_request_id IS NULL
      AND state_updated_at > created_at AND state_updated_at < expires_at
      AND state_event_sequence > created_event_sequence)
    OR (state_code = 'E' AND response_payload IS NULL AND answered_at IS NULL
      AND answered_by_kind IS NULL AND answered_by_principal_id IS NULL
      AND answered_by_grant_id IS NULL AND terminal_by_kind = 'S'
      AND terminal_by_principal_id = 'hitl-expiry-v1' AND terminal_by_grant_id IS NULL
      AND superseded_by_request_id IS NULL AND answered_request_id IS NULL
      AND state_updated_at = expires_at AND state_event_sequence > created_event_sequence)
    OR (state_code = 'C' AND response_payload IS NULL AND answered_at IS NULL
      AND answered_by_kind IS NULL AND answered_by_principal_id IS NULL
      AND answered_by_grant_id IS NULL AND terminal_by_kind IN ('U','M')
      AND terminal_by_principal_id IS NOT NULL
      AND ((terminal_by_kind = 'M' AND terminal_by_grant_id IS NOT NULL)
        OR (terminal_by_kind = 'U' AND terminal_by_grant_id IS NULL))
      AND superseded_by_request_id IS NULL AND answered_request_id IS NULL
      AND state_updated_at > created_at AND state_updated_at < expires_at
      AND state_event_sequence > created_event_sequence)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
