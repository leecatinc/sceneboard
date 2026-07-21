CREATE TABLE artifacts (
  artifact_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  board_pk BIGINT UNSIGNED NOT NULL,
  artifact_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (artifact_pk),
  UNIQUE KEY uq_artifacts_board_id (board_pk, artifact_id),
  UNIQUE KEY uq_artifacts_board_pk (board_pk, artifact_pk),
  CONSTRAINT fk_artifacts_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_artifacts_actor CHECK (
    created_by_kind IN ('U','M','S')
    AND ((created_by_kind = 'M' AND created_by_grant_id IS NOT NULL)
      OR (created_by_kind IN ('U','S') AND created_by_grant_id IS NULL))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
