CREATE TABLE board_revision_media_refs (
  board_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  media_id VARBINARY(128) NOT NULL,
  first_page_id VARBINARY(128) NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  PRIMARY KEY (revision_pk, media_id),
  UNIQUE KEY uq_revision_media_ref_order (revision_pk, ordinal),
  KEY ix_revision_media_ref_lookup (board_pk, media_id, revision_pk),
  CONSTRAINT fk_revision_media_refs_revision
    FOREIGN KEY (board_pk, revision_pk)
    REFERENCES board_revisions (board_pk, revision_pk)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT chk_revision_media_refs_media_id CHECK (OCTET_LENGTH(media_id) BETWEEN 1 AND 128),
  CONSTRAINT chk_revision_media_refs_page_id CHECK (OCTET_LENGTH(first_page_id) BETWEEN 1 AND 128),
  CONSTRAINT chk_revision_media_refs_ordinal CHECK (ordinal BETWEEN 1 AND 5000)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
