import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

export interface AccountApiKeyColumnProjection extends RowDataPacket {
  columnName: string;
  ordinalPosition: number;
  columnType: string;
  characterSetName: string | null;
  collationName: string | null;
  isNullable: string;
  columnDefault: string | null;
  extra: string;
}

export interface AccountApiKeyIndexProjection extends RowDataPacket {
  indexName: string;
  nonUnique: number;
  sequence: number;
  columnName: string;
  collation: string | null;
}

export interface AccountApiKeyForeignKeyProjection extends RowDataPacket {
  constraintName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  deleteRule: string;
  updateRule: string;
}

export interface AccountApiKeyCheckProjection extends RowDataPacket {
  constraintName: string;
  checkClause: string;
}

export interface DocumentV3CheckpointProjection extends RowDataPacket {
  tableName: string;
  constraintName: string;
  checkClause: string;
}

export interface RevisionExportHoldProjection {
  columnType: string;
  checkClause: string;
  primaryColumns: readonly string[];
  activeIndexColumns: readonly string[];
  foreignKeyColumns: readonly string[];
  holderCheckClause: string;
}

const expectedColumns = [
  ['id', 1, 'bigint unsigned', null, null, 'NO', null, 'auto_increment'],
  ['public_id', 2, 'varchar(128)', 'ascii', 'ascii_bin', 'NO', null, ''],
  ['owner_user_id', 3, 'bigint unsigned', null, null, 'NO', null, ''],
  ['display_name', 4, 'varchar(160)', 'utf8mb4', 'utf8mb4_0900_ai_ci', 'NO', null, ''],
  ['token_version', 5, 'tinyint unsigned', null, null, 'NO', '1', ''],
  ['token_locator', 6, 'binary(16)', null, null, 'NO', null, ''],
  ['token_hash', 7, 'binary(32)', null, null, 'NO', null, ''],
  ['scope_mask', 8, 'bigint unsigned', null, null, 'NO', null, ''],
  ['status', 9, 'tinyint unsigned', null, null, 'NO', '1', ''],
  ['expires_at', 10, 'datetime(3)', null, null, 'NO', null, ''],
  ['created_at', 11, 'datetime(3)', null, null, 'NO', 'CURRENT_TIMESTAMP(3)', 'DEFAULT_GENERATED'],
  ['last_used_at', 12, 'datetime(3)', null, null, 'YES', null, ''],
  ['revoked_at', 13, 'datetime(3)', null, null, 'YES', null, ''],
] as const;

const expectedIndexes = [
  ['PRIMARY', 0, 1, 'id'],
  ['ix_account_api_key_expiry', 1, 1, 'status'],
  ['ix_account_api_key_expiry', 1, 2, 'expires_at'],
  ['ix_account_api_key_expiry', 1, 3, 'id'],
  ['ix_account_api_key_owner_list', 1, 1, 'owner_user_id'],
  ['ix_account_api_key_owner_list', 1, 2, 'created_at'],
  ['ix_account_api_key_owner_list', 1, 3, 'id'],
  ['ix_account_api_key_owner_list', 1, 4, 'status'],
  ['uq_account_api_key_public_id', 0, 1, 'public_id'],
  ['uq_account_api_key_token_locator', 0, 1, 'token_locator'],
] as const;

const canonicalCheck = (value: string): string =>
  value
    .replace(/`/gu, '')
    .replace(/\\'/gu, "'")
    .replace(/\s+/gu, '')
    .replace(/\(\(([^()]*)\)\)/gu, '($1)')
    .toLowerCase()
    .replace(/_utf8mb4/gu, '')
    .replace(/octet_length/gu, 'length');

export const assessAccountApiKeyPostcondition = (
  columns: readonly AccountApiKeyColumnProjection[],
  indexes: readonly AccountApiKeyIndexProjection[],
  foreignKeys: readonly AccountApiKeyForeignKeyProjection[],
  checks: readonly AccountApiKeyCheckProjection[],
): void => {
  const actualColumns = columns.map((row) => [
    row.columnName,
    Number(row.ordinalPosition),
    row.columnType.toLowerCase(),
    row.characterSetName,
    row.collationName,
    row.isNullable,
    row.columnDefault,
    row.extra,
  ]);
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    throw new Error('account API-key column projection mismatch');
  }
  const actualIndexes = indexes.map((row) => [
    row.indexName,
    Number(row.nonUnique),
    Number(row.sequence),
    row.columnName,
  ]);
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    throw new Error('account API-key index projection mismatch');
  }
  const foreignKey = foreignKeys[0];
  if (
    foreignKeys.length !== 1 ||
    foreignKey?.constraintName !== 'fk_account_api_key_owner' ||
    foreignKey.columnName !== 'owner_user_id' ||
    foreignKey.referencedTableName !== 'users' ||
    foreignKey.referencedColumnName !== 'id' ||
    foreignKey.deleteRule !== 'RESTRICT' ||
    foreignKey.updateRule !== 'RESTRICT'
  ) {
    throw new Error('account API-key foreign-key projection mismatch');
  }
  const actualChecks = new Map(
    checks.map((row) => [
      row.constraintName,
      canonicalCheck(row.checkClause)
        .replace(/_utf8mb4/gu, '')
        .replace(/[()]/gu, ''),
    ]),
  );
  const requiredChecks = [
    'chk_account_api_key_public_id',
    'chk_account_api_key_display_name',
    'chk_account_api_key_token_version',
    'chk_account_api_key_scope_mask',
    'chk_account_api_key_status',
    'chk_account_api_key_times',
    'chk_account_api_key_terminal',
  ];
  if (
    actualChecks.size !== requiredChecks.length ||
    requiredChecks.some((name) => !actualChecks.has(name))
  ) {
    throw new Error('account API-key check projection mismatch');
  }
  const requiredFragments: Readonly<Record<string, readonly string[]>> = {
    chk_account_api_key_public_id: ["regexp_likepublic_id,'^[a-za-z0-9_-]{1,128}$','c'"],
    chk_account_api_key_display_name: [
      'display_name=trimdisplay_name',
      'char_lengthdisplay_namebetween1and80',
    ],
    chk_account_api_key_token_version: ['token_version=1'],
    chk_account_api_key_scope_mask: ['scope_maskbetween1and63'],
    chk_account_api_key_status: ['statusin1,2'],
    chk_account_api_key_times: [
      'created_at<expires_at',
      'last_used_atisnullorlast_used_at>=created_at',
      'revoked_atisnullorrevoked_at>=created_at',
    ],
    chk_account_api_key_terminal: ['status=1andrevoked_atisnull', 'status=2andrevoked_atisnotnull'],
  };
  for (const [name, fragments] of Object.entries(requiredFragments)) {
    const clause = actualChecks.get(name) ?? '';
    if (fragments.some((fragment) => !clause.includes(fragment))) {
      throw new Error(`account API-key check clause mismatch: ${name}`);
    }
  }
};

export const verifyAccountApiKeyPostcondition = async (
  connection: PoolConnection,
): Promise<void> => {
  const [columns] = await connection.query<AccountApiKeyColumnProjection[]>(
    `SELECT
       column_name AS columnName,
       ordinal_position AS ordinalPosition,
       column_type AS columnType,
       character_set_name AS characterSetName,
       collation_name AS collationName,
       is_nullable AS isNullable,
       column_default AS columnDefault,
       extra AS extra
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'account_api_keys'
     ORDER BY ordinal_position`,
  );
  const [indexes] = await connection.query<AccountApiKeyIndexProjection[]>(
    `SELECT
       index_name AS indexName,
       non_unique AS nonUnique,
       seq_in_index AS sequence,
       column_name AS columnName,
       collation
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'account_api_keys'
     ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index`,
  );
  const [foreignKeys] = await connection.query<AccountApiKeyForeignKeyProjection[]>(
    `SELECT
       kcu.constraint_name AS constraintName,
       kcu.column_name AS columnName,
       kcu.referenced_table_name AS referencedTableName,
       kcu.referenced_column_name AS referencedColumnName,
       rc.delete_rule AS deleteRule,
       rc.update_rule AS updateRule
     FROM information_schema.key_column_usage kcu
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_schema = kcu.constraint_schema
      AND rc.constraint_name = kcu.constraint_name
     WHERE kcu.table_schema = DATABASE()
       AND kcu.table_name = 'account_api_keys'
       AND kcu.referenced_table_name IS NOT NULL`,
  );
  const [checks] = await connection.query<AccountApiKeyCheckProjection[]>(
    `SELECT
       tc.constraint_name AS constraintName,
       cc.check_clause AS checkClause
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema = tc.constraint_schema
      AND cc.constraint_name = tc.constraint_name
     WHERE tc.table_schema = DATABASE()
       AND tc.table_name = 'account_api_keys'
       AND tc.constraint_type = 'CHECK'
     ORDER BY tc.constraint_name`,
  );
  assessAccountApiKeyPostcondition(columns, indexes, foreignKeys, checks);
};

export const assessDocumentV3CheckpointPostcondition = (
  rows: readonly DocumentV3CheckpointProjection[],
): void => {
  const projections = new Map(
    rows.map((row) => [`${row.tableName}.${row.constraintName}`, canonicalCheck(row.checkClause)]),
  );
  const expected = new Map([
    [
      'board_revision_payloads.chk_revision_payloads_checkpoint',
      [
        "codec='b'",
        'stored_bytes=length(payload)',
        "schema_version='1.0.0'",
        'canonical_bytesbetween1and786432',
        'stored_bytesbetween1and800000',
        "schema_version='2.0.0'",
        "schema_version='3.0.0'",
        'canonical_bytesbetween1and20971520',
        'stored_bytesbetween1and33554432',
      ],
    ],
    [
      'board_revisions.chk_revisions_retained_checkpoint',
      [
        'scene_schema_versionisnull',
        'scene_codecisnull',
        'scene_payloadisnull',
        'scene_canonical_bytesisnull',
        'scene_stored_bytesisnull',
        'scene_sha256isnull',
        'scene_schema_versionisnotnull',
        "scene_codec='b'",
        'scene_payloadisnotnull',
        'scene_canonical_bytesisnotnull',
        'scene_stored_bytes=length(scene_payload)',
        'scene_sha256isnotnull',
        "scene_schema_version='1.0.0'",
        "scene_schema_version='2.0.0'",
        "scene_schema_version='3.0.0'",
        'scene_canonical_bytesbetween1and786432',
        'scene_stored_bytesbetween1and800000',
        'scene_canonical_bytesbetween1and20971520',
        'scene_stored_bytesbetween1and33554432',
      ],
    ],
  ] as const);
  if (
    projections.size !== expected.size ||
    [...expected.keys()].some((name) => !projections.has(name))
  ) {
    throw new Error('document V3 checkpoint constraint projection mismatch');
  }
  for (const [name, fragments] of expected) {
    const clause = projections.get(name) ?? '';
    if (fragments.some((fragment) => !clause.includes(fragment))) {
      throw new Error(`document V3 checkpoint clause mismatch: ${name}`);
    }
  }
};

export const verifyDocumentV3CheckpointPostcondition = async (
  connection: PoolConnection,
): Promise<void> => {
  const [rows] = await connection.query<DocumentV3CheckpointProjection[]>(
    `SELECT
       tc.table_name AS tableName,
       tc.constraint_name AS constraintName,
       cc.check_clause AS checkClause
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema = tc.constraint_schema
      AND cc.constraint_name = tc.constraint_name
     WHERE tc.table_schema = DATABASE()
       AND (
         (tc.table_name = 'board_revision_payloads'
          AND tc.constraint_name = 'chk_revision_payloads_checkpoint')
         OR
         (tc.table_name = 'board_revisions'
          AND tc.constraint_name = 'chk_revisions_retained_checkpoint')
       )
     ORDER BY tc.table_name, tc.constraint_name`,
  );
  assessDocumentV3CheckpointPostcondition(rows);
};

const revisionHoldKinds = [
  'published',
  'media',
  'artifact',
  'idempotency',
  'outbox',
  'recovery',
  'restore',
  'export',
] as const;

export const assessRevisionExportHoldPostcondition = (
  projection: RevisionExportHoldProjection,
): void => {
  const expectedType = `enum(${revisionHoldKinds.map((kind) => `'${kind}'`).join(',')})`;
  if (projection.columnType.toLowerCase() !== expectedType)
    throw new Error('revision export hold column projection mismatch');
  const check = canonicalCheck(projection.checkClause).replace(/[()]/gu, '');
  if (check !== `kindin${revisionHoldKinds.map((kind) => `'${kind}'`).join(',')}`)
    throw new Error('revision export hold check projection mismatch');
  if (
    JSON.stringify(projection.primaryColumns) !==
      JSON.stringify(['board_pk', 'revision_pk', 'kind', 'holder_id']) ||
    JSON.stringify(projection.activeIndexColumns) !==
      JSON.stringify(['board_pk', 'released_at', 'expires_at', 'revision_pk']) ||
    JSON.stringify(projection.foreignKeyColumns) !==
      JSON.stringify(['board_pk:board_pk', 'revision_pk:revision_pk']) ||
    canonicalCheck(projection.holderCheckClause).replace(/[()]/gu, '') !==
      'char_lengthholder_idbetween1and191'
  )
    throw new Error('revision export hold surrounding projection mismatch');
};

export const verifyRevisionExportHoldPostcondition = async (
  connection: PoolConnection,
): Promise<void> => {
  const [columns] = await connection.query<Array<RowDataPacket & { columnType: string }>>(
    `SELECT column_type AS columnType
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'board_revision_holds'
       AND column_name = 'kind'`,
  );
  const [checks] = await connection.query<
    Array<RowDataPacket & { constraintName: string; checkClause: string }>
  >(
    `SELECT tc.constraint_name AS constraintName, cc.check_clause AS checkClause
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema = tc.constraint_schema
      AND cc.constraint_name = tc.constraint_name
     WHERE tc.table_schema = DATABASE()
       AND tc.table_name = 'board_revision_holds'
       AND tc.constraint_name IN ('chk_revision_holds_kind', 'chk_revision_holds_holder')
     ORDER BY tc.constraint_name`,
  );
  const [indexes] = await connection.query<
    Array<RowDataPacket & { indexName: string; columnName: string }>
  >(
    `SELECT index_name AS indexName, column_name AS columnName
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'board_revision_holds'
       AND index_name IN ('PRIMARY', 'ix_revision_holds_active')
     ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index`,
  );
  const [foreignKeys] = await connection.query<
    Array<RowDataPacket & { columnName: string; referencedColumnName: string }>
  >(
    `SELECT column_name AS columnName, referenced_column_name AS referencedColumnName
     FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE()
       AND table_name = 'board_revision_holds'
       AND constraint_name = 'fk_revision_holds_revision'
     ORDER BY ordinal_position`,
  );
  const kind = checks.find((row) => row.constraintName === 'chk_revision_holds_kind');
  const holder = checks.find((row) => row.constraintName === 'chk_revision_holds_holder');
  if (columns.length !== 1 || kind === undefined || holder === undefined || checks.length !== 2)
    throw new Error('revision export hold projection is incomplete');
  assessRevisionExportHoldPostcondition({
    columnType: columns[0]?.columnType ?? '',
    checkClause: kind.checkClause,
    primaryColumns: indexes
      .filter((row) => row.indexName === 'PRIMARY')
      .map((row) => row.columnName),
    activeIndexColumns: indexes
      .filter((row) => row.indexName === 'ix_revision_holds_active')
      .map((row) => row.columnName),
    foreignKeyColumns: foreignKeys.map((row) => `${row.columnName}:${row.referencedColumnName}`),
    holderCheckClause: holder.checkClause,
  });
};
