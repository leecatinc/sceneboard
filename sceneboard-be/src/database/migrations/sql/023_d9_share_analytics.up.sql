CREATE TABLE IF NOT EXISTS share_analytics_contexts (
  context_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  share_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  publication_generation BIGINT UNSIGNED NOT NULL,
  access_generation BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (context_id),
  KEY ix_share_analytics_context_expiry (expires_at, context_id),
  KEY ix_share_analytics_context_tuple (
    share_pk, publication_generation, access_generation, revision_pk, context_id
  ),
  CONSTRAINT fk_share_analytics_context_board FOREIGN KEY (board_pk)
    REFERENCES boards (board_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_share_analytics_context_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_share_analytics_context_revision FOREIGN KEY (revision_pk)
    REFERENCES board_revisions (revision_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_share_analytics_context_generations CHECK (
    publication_generation BETWEEN 1 AND 9007199254740991
    AND access_generation BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT chk_share_analytics_context_expiry CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_analytics_context_pages (
  context_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  page_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  page_ordinal SMALLINT UNSIGNED NOT NULL,
  title_label VARCHAR(120) NOT NULL,
  PRIMARY KEY (context_id, page_id),
  UNIQUE KEY uq_share_analytics_context_page_ordinal (context_id, page_ordinal),
  CONSTRAINT fk_share_analytics_context_page_context FOREIGN KEY (context_id)
    REFERENCES share_analytics_contexts (context_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_share_analytics_context_page_ordinal CHECK (page_ordinal <= 999)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_analytics_replays (
  replay_family_key BINARY(32) NOT NULL,
  context_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_kind ENUM('first-visible','page-visible') NOT NULL,
  page_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome ENUM('counted','deduped') NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (replay_family_key, context_id, idempotency_key),
  KEY ix_share_analytics_replay_expiry (expires_at, context_id),
  CONSTRAINT fk_share_analytics_replay_context FOREIGN KEY (context_id)
    REFERENCES share_analytics_contexts (context_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_share_analytics_replay_expiry CHECK (
    expires_at > created_at AND expires_at <= created_at + INTERVAL 48 HOUR
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_analytics_rolling_admissions (
  viewer_dedupe_key BINARY(32) NOT NULL,
  share_pk BIGINT UNSIGNED NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  publication_generation BIGINT UNSIGNED NOT NULL,
  access_generation BIGINT UNSIGNED NOT NULL,
  metric_kind ENUM('board-open','page-view') NOT NULL,
  page_dimension VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_counted_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (
    viewer_dedupe_key, share_pk, board_pk, revision_pk, publication_generation,
    access_generation, metric_kind, page_dimension
  ),
  KEY ix_share_analytics_admission_expiry (expires_at, share_pk),
  CONSTRAINT fk_share_analytics_admission_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_share_analytics_admission_dimension CHECK (
    (metric_kind = 'board-open' AND page_dimension = '__BOARD__')
    OR (metric_kind = 'page-view' AND page_dimension <> '__BOARD__')
  ),
  CONSTRAINT chk_share_analytics_admission_expiry CHECK (
    expires_at > last_counted_at AND expires_at <= last_counted_at + INTERVAL 48 HOUR
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_analytics_daily_viewers (
  viewer_daily_key BINARY(32) NOT NULL,
  board_pk BIGINT UNSIGNED NOT NULL,
  share_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  publication_generation BIGINT UNSIGNED NOT NULL,
  `utc_date` DATE NOT NULL,
  first_seen_at DATETIME(3) NOT NULL,
  PRIMARY KEY (
    viewer_daily_key, board_pk, share_pk, revision_pk, publication_generation, `utc_date`
  ),
  KEY ix_share_analytics_daily_viewer_retention (`utc_date`, board_pk, share_pk),
  CONSTRAINT fk_share_analytics_daily_viewer_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_analytics_daily_aggregates (
  board_pk BIGINT UNSIGNED NOT NULL,
  share_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  publication_generation BIGINT UNSIGNED NOT NULL,
  `utc_date` DATE NOT NULL,
  metric_kind ENUM('board-open','page-view') NOT NULL,
  page_dimension VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  page_ordinal SMALLINT UNSIGNED NULL,
  title_label VARCHAR(120) NULL,
  metric_count BIGINT UNSIGNED NOT NULL,
  last_aggregated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (
    board_pk, share_pk, revision_pk, publication_generation, `utc_date`,
    metric_kind, page_dimension
  ),
  KEY ix_share_analytics_daily_report (
    board_pk, `utc_date`, publication_generation, page_ordinal, page_dimension
  ),
  CONSTRAINT fk_share_analytics_daily_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_share_analytics_daily_metric CHECK (
    metric_count BETWEEN 0 AND 9007199254740991
    AND (
      (metric_kind = 'board-open' AND page_dimension = '__BOARD__'
        AND page_ordinal IS NULL AND title_label IS NULL)
      OR (metric_kind = 'page-view' AND page_dimension <> '__BOARD__'
        AND page_ordinal IS NOT NULL AND title_label IS NOT NULL)
    )
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_analytics_lifetime_aggregates (
  board_pk BIGINT UNSIGNED NOT NULL,
  share_pk BIGINT UNSIGNED NOT NULL,
  revision_pk BIGINT UNSIGNED NOT NULL,
  publication_generation BIGINT UNSIGNED NOT NULL,
  metric_kind ENUM('board-open','page-view') NOT NULL,
  page_dimension VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  page_ordinal SMALLINT UNSIGNED NULL,
  title_label VARCHAR(120) NULL,
  metric_count BIGINT UNSIGNED NOT NULL,
  last_aggregated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (
    board_pk, share_pk, revision_pk, publication_generation, metric_kind, page_dimension
  ),
  KEY ix_share_analytics_lifetime_report (
    board_pk, publication_generation, page_ordinal, page_dimension
  ),
  CONSTRAINT fk_share_analytics_lifetime_share FOREIGN KEY (share_pk)
    REFERENCES board_shares (share_pk) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_share_analytics_lifetime_metric CHECK (
    metric_count BETWEEN 0 AND 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS share_analytics_cleanup_leases (
  name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lease_owner VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  fence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_expires_at DATETIME(3) NULL,
  cursor_value VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (name),
  CONSTRAINT chk_share_analytics_cleanup_fence CHECK (
    fence BETWEEN 0 AND 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
