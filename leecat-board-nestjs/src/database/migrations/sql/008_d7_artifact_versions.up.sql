CREATE TABLE artifact_versions (
  version_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  board_pk BIGINT UNSIGNED NOT NULL,
  artifact_pk BIGINT UNSIGNED NOT NULL,
  version_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_ordinal BIGINT UNSIGNED NOT NULL,
  entry_path VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  manifest_payload MEDIUMBLOB NOT NULL,
  manifest_canonical_bytes INT UNSIGNED NOT NULL,
  manifest_sha256 BINARY(32) NOT NULL,
  requested_capability_mask TINYINT UNSIGNED NOT NULL,
  sanitizer_policy_version SMALLINT UNSIGNED NOT NULL,
  resource_count SMALLINT UNSIGNED NOT NULL,
  resource_total_bytes INT UNSIGNED NOT NULL,
  created_by_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (version_pk),
  UNIQUE KEY uq_artifact_versions_pair (artifact_pk, version_id),
  UNIQUE KEY uq_artifact_versions_ordinal (artifact_pk, version_ordinal),
  UNIQUE KEY uq_artifact_versions_board_pk (board_pk, version_pk),
  KEY ix_artifact_versions_lookup (board_pk, artifact_pk, version_id),
  CONSTRAINT fk_artifact_versions_artifact FOREIGN KEY (board_pk, artifact_pk)
    REFERENCES artifacts (board_pk, artifact_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_artifact_versions_ordinal CHECK (
    version_ordinal BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_artifact_versions_manifest CHECK (
    manifest_canonical_bytes BETWEEN 1 AND 1048576
    AND manifest_canonical_bytes = OCTET_LENGTH(manifest_payload)
  ),
  CONSTRAINT chk_artifact_versions_capabilities CHECK (requested_capability_mask BETWEEN 0 AND 15),
  CONSTRAINT chk_artifact_versions_policy CHECK (sanitizer_policy_version = 1),
  CONSTRAINT chk_artifact_versions_resources CHECK (
    resource_count BETWEEN 1 AND 128
    AND resource_total_bytes BETWEEN 0 AND 10485760
  ),
  CONSTRAINT chk_artifact_versions_actor CHECK (
    created_by_kind IN ('U','M','S')
    AND ((created_by_kind = 'M' AND created_by_grant_id IS NOT NULL)
      OR (created_by_kind IN ('U','S') AND created_by_grant_id IS NULL))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
