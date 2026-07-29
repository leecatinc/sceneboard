ALTER TABLE mcp_grants
  DROP CHECK ck_mcp_grants_masks,
  ADD CONSTRAINT ck_mcp_grants_masks CHECK (
    scope_mask BETWEEN 1 AND 255
    AND lifecycle_mask BETWEEN 0 AND 3
  );

ALTER TABLE pairing_requests
  DROP CHECK ck_pairing_scope_masks,
  DROP CHECK ck_pairing_state_fields,
  ADD CONSTRAINT ck_pairing_scope_masks CHECK (
    requested_scope_mask BETWEEN 0 AND 255
    AND requested_lifecycle_mask BETWEEN 0 AND 3
    AND (approved_scope_mask IS NULL OR (
      approved_scope_mask BETWEEN 1 AND 255
      AND (approved_scope_mask & requested_scope_mask) = approved_scope_mask
    ))
    AND (approved_lifecycle_mask IS NULL OR (
      approved_lifecycle_mask BETWEEN 0 AND 3
      AND (approved_lifecycle_mask & requested_lifecycle_mask) = approved_lifecycle_mask
    ))
  ),
  ADD CONSTRAINT ck_pairing_state_fields CHECK (
    (state = 1 AND code_locator_hash IS NOT NULL AND code_verifier_hash IS NOT NULL
      AND client_id IS NULL AND client_proof_challenge IS NULL
      AND requested_scope_mask = 0 AND requested_lifecycle_mask = 0
      AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
      AND claimed_at IS NULL AND decision_expires_at IS NULL AND decided_at IS NULL
      AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count BETWEEN 0 AND 4)
    OR
    (state = 2 AND code_locator_hash IS NULL AND code_verifier_hash IS NULL
      AND client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
      AND requested_scope_mask BETWEEN 1 AND 255 AND requested_lifecycle_mask BETWEEN 0 AND 3
      AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
      AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NULL
      AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count BETWEEN 0 AND 4)
    OR
    (state IN (3, 4) AND code_locator_hash IS NULL AND code_verifier_hash IS NULL
      AND client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
      AND requested_scope_mask BETWEEN 1 AND 255 AND requested_lifecycle_mask BETWEEN 0 AND 3
      AND approved_scope_mask BETWEEN 1 AND 255
      AND approved_lifecycle_mask BETWEEN 0 AND 3 AND lifetime IN (1, 2)
      AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NOT NULL
      AND redeem_expires_at IS NOT NULL AND grant_id IS NOT NULL
      AND matched_failure_count BETWEEN 0 AND 4)
    OR
    (state = 5 AND code_locator_hash IS NULL AND code_verifier_hash IS NULL
      AND client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
      AND requested_scope_mask BETWEEN 1 AND 255 AND requested_lifecycle_mask BETWEEN 0 AND 3
      AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
      AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NOT NULL
      AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count BETWEEN 0 AND 4)
    OR
    (state IN (6, 7) AND code_locator_hash IS NULL AND code_verifier_hash IS NULL AND (
      (client_id IS NULL AND client_proof_challenge IS NULL
        AND requested_scope_mask = 0 AND requested_lifecycle_mask = 0
        AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
        AND claimed_at IS NULL AND decision_expires_at IS NULL AND decided_at IS NULL
        AND redeem_expires_at IS NULL AND grant_id IS NULL
        AND matched_failure_count BETWEEN 0 AND 4)
      OR
      (client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
        AND requested_scope_mask BETWEEN 1 AND 255 AND requested_lifecycle_mask BETWEEN 0 AND 3
        AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
        AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL AND decided_at IS NULL
        AND redeem_expires_at IS NULL AND grant_id IS NULL
        AND matched_failure_count BETWEEN 0 AND 4)
      OR
      (client_id IS NOT NULL AND client_proof_challenge IS NOT NULL
        AND requested_scope_mask BETWEEN 1 AND 255 AND requested_lifecycle_mask BETWEEN 0 AND 3
        AND approved_scope_mask BETWEEN 1 AND 255
        AND approved_lifecycle_mask BETWEEN 0 AND 3 AND lifetime IN (1, 2)
        AND claimed_at IS NOT NULL AND decision_expires_at IS NOT NULL
        AND decided_at IS NOT NULL AND redeem_expires_at IS NOT NULL
        AND grant_id IS NOT NULL AND matched_failure_count BETWEEN 0 AND 4)
    ))
    OR
    (state = 8 AND code_locator_hash IS NULL AND code_verifier_hash IS NULL
      AND client_id IS NULL AND client_proof_challenge IS NULL
      AND requested_scope_mask = 0 AND requested_lifecycle_mask = 0
      AND approved_scope_mask IS NULL AND approved_lifecycle_mask IS NULL AND lifetime IS NULL
      AND claimed_at IS NULL AND decision_expires_at IS NULL AND decided_at IS NULL
      AND redeem_expires_at IS NULL AND grant_id IS NULL AND matched_failure_count = 5)
  );
