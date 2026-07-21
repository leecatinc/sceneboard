CREATE TABLE artifact_resources (
  resource_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_pk BIGINT UNSIGNED NOT NULL,
  resource_ordinal SMALLINT UNSIGNED NOT NULL,
  resource_path VARBINARY(1024) NOT NULL,
  media_type VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_sha256 BINARY(32) NOT NULL,
  resource_bytes INT UNSIGNED NOT NULL,
  resource_payload MEDIUMBLOB NOT NULL,
  PRIMARY KEY (resource_pk),
  UNIQUE KEY uq_artifact_resources_ordinal (version_pk, resource_ordinal),
  UNIQUE KEY uq_artifact_resources_path (version_pk, resource_path),
  CONSTRAINT fk_artifact_resources_version FOREIGN KEY (version_pk)
    REFERENCES artifact_versions (version_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_artifact_resources_ordinal CHECK (resource_ordinal BETWEEN 1 AND 128),
  CONSTRAINT chk_artifact_resources_bytes CHECK (
    resource_bytes BETWEEN 0 AND 5242880
    AND resource_bytes = OCTET_LENGTH(resource_payload)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
