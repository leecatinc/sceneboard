ALTER TABLE board_revisions
  DROP CHECK chk_revisions_origin,
  DROP CHECK chk_revisions_schema,
  DROP CHECK chk_revisions_codec,
  DROP CHECK chk_revisions_size,
  MODIFY COLUMN scene_payload LONGBLOB NOT NULL,
  MODIFY COLUMN scene_canonical_bytes INT UNSIGNED NOT NULL,
  MODIFY COLUMN scene_stored_bytes INT UNSIGNED NOT NULL,
  ADD CONSTRAINT chk_revisions_origin
    CHECK (origin_code IN ('C','R','L','S','D')),
  ADD CONSTRAINT chk_revisions_codec
    CHECK (scene_codec = 'B'),
  ADD CONSTRAINT chk_revisions_checkpoint
    CHECK (
      scene_codec = 'B'
      AND scene_stored_bytes = OCTET_LENGTH(scene_payload)
      AND (
        (
          scene_schema_version = '1.0.0'
          AND scene_canonical_bytes BETWEEN 1 AND 786432
          AND scene_stored_bytes BETWEEN 1 AND 800000
        )
        OR (
          scene_schema_version = '2.0.0'
          AND scene_canonical_bytes BETWEEN 1 AND 20971520
          AND scene_stored_bytes BETWEEN 1 AND 33554432
        )
      )
    );
