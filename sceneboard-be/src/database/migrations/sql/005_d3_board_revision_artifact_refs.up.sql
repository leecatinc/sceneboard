CREATE TABLE board_revision_artifact_refs (
  ref_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  revision_pk BIGINT UNSIGNED NOT NULL,
  artifact_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  artifact_version_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reference_code CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occurrence_count SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (ref_pk),
  UNIQUE KEY uq_revision_artifact_ref (revision_pk, artifact_id, artifact_version_id, reference_code),
  KEY ix_artifact_revision (artifact_id, artifact_version_id, revision_pk),
  CONSTRAINT fk_revision_artifact_revision FOREIGN KEY (revision_pk)
    REFERENCES board_revisions (revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_revision_artifact_code CHECK (reference_code IN ('A','I')),
  CONSTRAINT chk_revision_artifact_count CHECK (occurrence_count BETWEEN 1 AND 500)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
