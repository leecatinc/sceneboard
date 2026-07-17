CREATE TABLE board_revisions (
  revision_pk BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  revision_id BINARY(16) NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  revision_number BIGINT UNSIGNED NOT NULL,
  previous_revision_pk BIGINT UNSIGNED NULL,
  source_revision_pk BIGINT UNSIGNED NULL,
  origin_code CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(200) NOT NULL,
  scene_schema_version CHAR(5) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scene_codec CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scene_payload MEDIUMBLOB NOT NULL,
  scene_canonical_bytes MEDIUMINT UNSIGNED NOT NULL,
  scene_stored_bytes MEDIUMINT UNSIGNED NOT NULL,
  scene_sha256 BINARY(32) NOT NULL,
  actor_kind CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_grant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_scope_sha256 BINARY(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (revision_pk),
  UNIQUE KEY uq_revisions_revision_id (revision_id),
  UNIQUE KEY uq_revisions_board_pk (board_pk, revision_pk),
  UNIQUE KEY uq_revisions_board_number (board_pk, revision_number),
  UNIQUE KEY uq_revisions_head_tuple (board_pk, revision_pk, revision_number),
  KEY ix_revisions_previous (board_pk, previous_revision_pk),
  KEY ix_revisions_source (board_pk, source_revision_pk),
  CONSTRAINT fk_revisions_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_revisions_previous FOREIGN KEY (board_pk, previous_revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT fk_revisions_source FOREIGN KEY (board_pk, source_revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk) ON DELETE RESTRICT,
  CONSTRAINT chk_revisions_number CHECK (
    revision_number BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_revisions_origin CHECK (origin_code IN ('C','R','L','S')),
  CONSTRAINT chk_revisions_schema CHECK (scene_schema_version = '1.0.0'),
  CONSTRAINT chk_revisions_codec CHECK (scene_codec = 'B'),
  CONSTRAINT chk_revisions_size CHECK (
    scene_canonical_bytes BETWEEN 1 AND 786432
    AND scene_stored_bytes BETWEEN 1 AND 800000
    AND scene_stored_bytes = OCTET_LENGTH(scene_payload)
  ),
  CONSTRAINT chk_revisions_actor CHECK (actor_kind IN ('U','M','S')),
  CONSTRAINT chk_revisions_actor_grant CHECK (
    (actor_kind = 'M' AND actor_grant_id IS NOT NULL)
    OR (actor_kind IN ('U','S') AND actor_grant_id IS NULL)
  ),
  CONSTRAINT chk_revisions_label CHECK (CHAR_LENGTH(label) BETWEEN 1 AND 200)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
