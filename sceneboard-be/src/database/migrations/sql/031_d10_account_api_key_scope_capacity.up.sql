ALTER TABLE account_api_keys
  DROP CHECK chk_account_api_key_scope_mask,
  ADD CONSTRAINT chk_account_api_key_scope_mask CHECK (scope_mask BETWEEN 1 AND 2047);
