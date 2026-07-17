CREATE TABLE artifact_runtime_states (
  version_pk BIGINT UNSIGNED NOT NULL,
  status_code CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  failure_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  failure_message VARCHAR(200) NULL,
  last_event_sequence BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (version_pk),
  KEY ix_artifact_runtime_event (last_event_sequence, version_pk),
  CONSTRAINT fk_artifact_runtime_version FOREIGN KEY (version_pk)
    REFERENCES artifact_versions (version_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_artifact_runtime_status CHECK (status_code IN ('R','S','F','B')),
  CONSTRAINT chk_artifact_runtime_failure CHECK (
    (status_code IN ('F','B') AND failure_code IS NOT NULL AND failure_message IS NOT NULL)
    OR (status_code IN ('R','S') AND failure_code IS NULL AND failure_message IS NULL)
  ),
  CONSTRAINT chk_artifact_runtime_sequence CHECK (
    last_event_sequence BETWEEN 1 AND 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
