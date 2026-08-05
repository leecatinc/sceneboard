INSERT INTO board_revision_payloads (
  revision_pk,
  schema_version,
  codec,
  canonical_bytes,
  stored_bytes,
  payload_sha256,
  payload,
  state
)
SELECT
  r.revision_pk,
  r.scene_schema_version,
  r.scene_codec,
  r.scene_canonical_bytes,
  r.scene_stored_bytes,
  r.scene_sha256,
  r.scene_payload,
  'available'
FROM board_revisions r
LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk
WHERE p.revision_pk IS NULL
  AND r.scene_schema_version IS NOT NULL
  AND r.scene_codec IS NOT NULL
  AND r.scene_canonical_bytes IS NOT NULL
  AND r.scene_stored_bytes IS NOT NULL
  AND r.scene_sha256 IS NOT NULL
  AND r.scene_payload IS NOT NULL;

INSERT INTO board_revision_catalog (
  board_pk,
  revision_pk,
  retained_order,
  is_head,
  truncated_before,
  actor_account_pk,
  actor_class,
  created_at
)
SELECT
  r.board_pk,
  r.revision_pk,
  r.revision_number,
  CASE WHEN h.head_revision_pk = r.revision_pk THEN 1 ELSE 0 END,
  0,
  u.id,
  CASE
    WHEN r.actor_kind = 'S' THEN 'system'
    WHEN u.id = b.owner_user_id THEN 'owner'
    ELSE 'editor'
  END,
  r.created_at
FROM board_revisions r
JOIN boards b ON b.board_pk = r.board_pk
JOIN board_heads h ON h.board_pk = r.board_pk
JOIN board_revision_payloads p
  ON p.revision_pk = r.revision_pk AND p.state = 'available'
LEFT JOIN users u ON r.actor_kind = 'U' AND u.public_id = r.actor_principal_id
LEFT JOIN board_revision_catalog c
  ON c.board_pk = r.board_pk AND c.revision_pk = r.revision_pk
WHERE c.revision_pk IS NULL
  AND r.scene_payload IS NOT NULL;
