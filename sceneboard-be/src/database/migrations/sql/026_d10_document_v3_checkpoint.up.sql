ALTER TABLE board_revision_payloads
  DROP CHECK chk_revision_payloads_checkpoint,
  ADD CONSTRAINT chk_revision_payloads_checkpoint CHECK (
    codec = 'B'
    AND stored_bytes = OCTET_LENGTH(payload)
    AND (
      (
        schema_version = '1.0.0'
        AND canonical_bytes BETWEEN 1 AND 786432
        AND stored_bytes BETWEEN 1 AND 800000
      )
      OR (
        schema_version = '2.0.0'
        AND canonical_bytes BETWEEN 1 AND 20971520
        AND stored_bytes BETWEEN 1 AND 33554432
      )
      OR (
        schema_version = '3.0.0'
        AND canonical_bytes BETWEEN 1 AND 20971520
        AND stored_bytes BETWEEN 1 AND 33554432
      )
    )
  );

ALTER TABLE board_revisions
  DROP CHECK chk_revisions_retained_checkpoint,
  ADD CONSTRAINT chk_revisions_retained_checkpoint CHECK (
    (
      scene_schema_version IS NULL
      AND scene_codec IS NULL
      AND scene_payload IS NULL
      AND scene_canonical_bytes IS NULL
      AND scene_stored_bytes IS NULL
      AND scene_sha256 IS NULL
    )
    OR
    (
      scene_schema_version IS NOT NULL
      AND scene_codec = 'B'
      AND scene_payload IS NOT NULL
      AND scene_canonical_bytes IS NOT NULL
      AND scene_stored_bytes = OCTET_LENGTH(scene_payload)
      AND scene_sha256 IS NOT NULL
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
        OR (
          scene_schema_version = '3.0.0'
          AND scene_canonical_bytes BETWEEN 1 AND 20971520
          AND scene_stored_bytes BETWEEN 1 AND 33554432
        )
      )
    )
  );
