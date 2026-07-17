CREATE TABLE artifact_board_usage (
  board_pk BIGINT UNSIGNED NOT NULL,
  artifact_count BIGINT UNSIGNED NOT NULL,
  version_count BIGINT UNSIGNED NOT NULL,
  resource_count BIGINT UNSIGNED NOT NULL,
  manifest_canonical_bytes BIGINT UNSIGNED NOT NULL,
  resource_bytes BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (board_pk),
  CONSTRAINT fk_artifact_usage_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_artifact_usage_limits CHECK (
    artifact_count BETWEEN 0 AND 100
    AND version_count BETWEEN 0 AND 1000
    AND resource_count BETWEEN 0 AND 10000
    AND manifest_canonical_bytes + resource_bytes <= 536870912
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
