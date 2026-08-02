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

export interface DocumentReplaceIdempotencyColumnProjection extends RowDataPacket {
  columnName: string;
  columnType: string;
  isNullable: string;
}

export interface DocumentReplaceIdempotencyCheckProjection extends RowDataPacket {
  constraintName: string;
  checkClause: string;
}

export interface DocumentReplaceIdempotencyIndexProjection extends RowDataPacket {
  indexName: string;
  nonUnique: number;
  sequence: number;
  columnName: string;
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
  ['PRIMARY', 0, 1, 'id', 'A'],
  ['ix_account_api_key_expiry', 1, 1, 'status', 'A'],
  ['ix_account_api_key_expiry', 1, 2, 'expires_at', 'A'],
  ['ix_account_api_key_expiry', 1, 3, 'id', 'A'],
  ['ix_account_api_key_owner_list', 1, 1, 'owner_user_id', 'A'],
  ['ix_account_api_key_owner_list', 1, 2, 'created_at', 'D'],
  ['ix_account_api_key_owner_list', 1, 3, 'id', 'D'],
  ['ix_account_api_key_owner_list', 1, 4, 'status', 'A'],
  ['uq_account_api_key_public_id', 0, 1, 'public_id', 'A'],
  ['uq_account_api_key_token_locator', 0, 1, 'token_locator', 'A'],
] as const;

type CheckToken = {
  kind: 'word' | 'literal' | 'symbol';
  value: string;
};

type CheckNode =
  | CheckToken
  | {
      kind: 'parentheses';
      callable: boolean;
      children: CheckNode[];
    };

const tokenizeCheck = (value: string): CheckToken[] => {
  const normalized = value.replace(/\\'/gu, "'");
  const tokens: CheckToken[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (/\s/u.test(character)) continue;
    if (character === '`') {
      const closing = normalized.indexOf('`', index + 1);
      if (closing === -1)
        throw new TypeError('account API-key check contains an invalid identifier');
      tokens.push({ kind: 'word', value: normalized.slice(index + 1, closing).toLowerCase() });
      index = closing;
      continue;
    }
    if (character === "'") {
      let literal = character;
      for (index += 1; index < normalized.length; index += 1) {
        const literalCharacter = normalized[index]!;
        literal += literalCharacter;
        if (literalCharacter !== "'") continue;
        if (normalized[index + 1] === "'") {
          literal += normalized[index + 1];
          index += 1;
          continue;
        }
        break;
      }
      if (tokens.at(-1)?.kind === 'word' && tokens.at(-1)?.value === '_utf8mb4') tokens.pop();
      tokens.push({ kind: 'literal', value: literal });
      continue;
    }
    if (/[A-Za-z0-9_$]/u.test(character)) {
      let end = index + 1;
      while (end < normalized.length && /[A-Za-z0-9_$]/u.test(normalized[end]!)) end += 1;
      const word = normalized.slice(index, end).toLowerCase();
      tokens.push({ kind: 'word', value: word === 'octet_length' ? 'length' : word });
      index = end - 1;
      continue;
    }
    const pairedOperator = normalized.slice(index, index + 2);
    if (['<=', '>=', '<>', '!=', '||', '&&'].includes(pairedOperator)) {
      tokens.push({ kind: 'symbol', value: pairedOperator });
      index += 1;
      continue;
    }
    tokens.push({ kind: 'symbol', value: character });
  }
  return tokens;
};

const parseCheckNodes = (
  tokens: readonly CheckToken[],
  start = 0,
): { nodes: CheckNode[]; next: number } => {
  const nodes: CheckNode[] = [];
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'symbol' || token.value !== '(') {
      if (token.kind === 'symbol' && token.value === ')') return { nodes, next: index + 1 };
      nodes.push(token);
      continue;
    }
    const previous = nodes.at(-1);
    const nested = parseCheckNodes(tokens, index + 1);
    nodes.push({
      kind: 'parentheses',
      callable: previous?.kind === 'word' && !['and', 'or', 'not'].includes(previous.value),
      children: nested.nodes,
    });
    index = nested.next - 1;
  }
  return { nodes, next: tokens.length };
};

const hasTopLevelBoolean = (nodes: readonly CheckNode[]): boolean => {
  let between = false;
  for (const node of nodes) {
    if (node.kind !== 'word') continue;
    if (node.value === 'between') {
      between = true;
      continue;
    }
    if (node.value === 'or') return true;
    if (node.value !== 'and') continue;
    if (!between) return true;
    between = false;
  }
  return false;
};

const normalizeCheckNodes = (nodes: readonly CheckNode[], root: boolean): CheckNode[] => {
  let normalized = nodes.flatMap<CheckNode>((node) => {
    if (node.kind !== 'parentheses') return [node];
    const children = normalizeCheckNodes(node.children, false);
    if (!node.callable && !hasTopLevelBoolean(children)) return children;
    return [{ ...node, children }];
  });
  while (
    root &&
    normalized.length === 1 &&
    normalized[0]?.kind === 'parentheses' &&
    !normalized[0].callable
  ) {
    normalized = normalizeCheckNodes(normalized[0].children, true);
  }
  return normalized;
};

const renderCheckNodes = (nodes: readonly CheckNode[]): string =>
  nodes
    .map((node) =>
      node.kind === 'parentheses' ? `(${renderCheckNodes(node.children)})` : node.value,
    )
    .join('');

const canonicalCheck = (value: string): string =>
  renderCheckNodes(normalizeCheckNodes(parseCheckNodes(tokenizeCheck(value)).nodes, true));

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
    row.collation,
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
    checks.map((row) => [row.constraintName, canonicalCheck(row.checkClause)]),
  );
  const expectedChecks: Readonly<Record<string, string>> = {
    chk_account_api_key_public_id: "REGEXP_LIKE(public_id, '^[A-Za-z0-9_-]{1,128}$', 'c')",
    chk_account_api_key_display_name:
      'display_name = TRIM(display_name) AND CHAR_LENGTH(display_name) BETWEEN 1 AND 80',
    chk_account_api_key_token_version: 'token_version = 1',
    chk_account_api_key_scope_mask: 'scope_mask BETWEEN 1 AND 63',
    chk_account_api_key_status: 'status IN (1, 2)',
    chk_account_api_key_times:
      'created_at < expires_at AND (last_used_at IS NULL OR last_used_at >= created_at) AND (revoked_at IS NULL OR revoked_at >= created_at)',
    chk_account_api_key_terminal:
      '(status = 1 AND revoked_at IS NULL) OR (status = 2 AND revoked_at IS NOT NULL)',
  };
  const requiredChecks = Object.keys(expectedChecks);
  if (
    actualChecks.size !== requiredChecks.length ||
    requiredChecks.some((name) => !actualChecks.has(name))
  ) {
    throw new Error('account API-key check projection mismatch');
  }
  for (const [name, expectedClause] of Object.entries(expectedChecks)) {
    if (actualChecks.get(name) !== canonicalCheck(expectedClause)) {
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
       collation AS collation
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
  const expected: ReadonlyMap<string, string> = new Map([
    [
      'board_revision_payloads.chk_revision_payloads_checkpoint',
      canonicalCheck(`
        codec = 'B'
        AND stored_bytes = LENGTH(payload)
        AND (
          (schema_version = '1.0.0'
            AND canonical_bytes BETWEEN 1 AND 786432
            AND stored_bytes BETWEEN 1 AND 800000)
          OR (schema_version = '2.0.0'
            AND canonical_bytes BETWEEN 1 AND 20971520
            AND stored_bytes BETWEEN 1 AND 33554432)
          OR (schema_version = '3.0.0'
            AND canonical_bytes BETWEEN 1 AND 20971520
            AND stored_bytes BETWEEN 1 AND 33554432)
        )
      `),
    ],
    [
      'board_revisions.chk_revisions_retained_checkpoint',
      canonicalCheck(`
        (scene_schema_version IS NULL
          AND scene_codec IS NULL
          AND scene_payload IS NULL
          AND scene_canonical_bytes IS NULL
          AND scene_stored_bytes IS NULL
          AND scene_sha256 IS NULL)
        OR
        (scene_schema_version IS NOT NULL
          AND scene_codec = 'B'
          AND scene_payload IS NOT NULL
          AND scene_canonical_bytes IS NOT NULL
          AND scene_stored_bytes = LENGTH(scene_payload)
          AND scene_sha256 IS NOT NULL
          AND (
            (scene_schema_version = '1.0.0'
              AND scene_canonical_bytes BETWEEN 1 AND 786432
              AND scene_stored_bytes BETWEEN 1 AND 800000)
            OR (scene_schema_version = '2.0.0'
              AND scene_canonical_bytes BETWEEN 1 AND 20971520
              AND scene_stored_bytes BETWEEN 1 AND 33554432)
            OR (scene_schema_version = '3.0.0'
              AND scene_canonical_bytes BETWEEN 1 AND 20971520
              AND scene_stored_bytes BETWEEN 1 AND 33554432)
          )
        )
      `),
    ],
  ]);
  if (
    projections.size !== expected.size ||
    [...expected.keys()].some((name) => !projections.has(name))
  ) {
    throw new Error('document V3 checkpoint constraint projection mismatch');
  }
  for (const [name, expectedClause] of expected) {
    if (projections.get(name) !== expectedClause) {
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

export const assessDocumentReplaceIdempotencyPostcondition = (
  columns: readonly DocumentReplaceIdempotencyColumnProjection[],
  checks: readonly DocumentReplaceIdempotencyCheckProjection[],
  indexes: readonly DocumentReplaceIdempotencyIndexProjection[],
): void => {
  const actualColumns = columns.map((row) => [
    row.columnName,
    row.columnType.toLowerCase(),
    row.isNullable,
  ]);
  const expectedColumns = [
    ['fingerprint_payload', 'longblob', 'NO'],
    ['fingerprint_canonical_bytes', 'int unsigned', 'NO'],
    ['result_payload', 'longblob', 'YES'],
    ['result_canonical_bytes', 'int unsigned', 'YES'],
  ];
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns))
    throw new Error('document replace idempotency column projection mismatch');

  const actualChecks = new Map(
    checks.map((row) => [row.constraintName, canonicalCheck(row.checkClause)]),
  );
  const expectedChecks: Readonly<Record<string, string>> = {
    chk_idempotency_scope_shape: `(scope_code = 'C' AND scope_subject = 'board.create'
      AND expected_revision_id IS NULL AND operation_type = 'board.create')
      OR (scope_code = 'A' AND scope_subject <> 'board.create'
      AND expected_revision_id IS NULL AND operation_type = 'board.archive')
      OR (scope_code = 'M' AND scope_subject <> 'board.create'
      AND expected_revision_id IS NOT NULL AND operation_type IN (
        'scene.replace','scene.clear','scene.restore','hitl.request','hitl.respond',
        'artifact.publish','artifact.stop','document.replace'))`,
    chk_idempotency_fingerprint: `fingerprint_version = 1
      AND fingerprint_canonical_bytes BETWEEN 1 AND 33554432
      AND fingerprint_canonical_bytes = OCTET_LENGTH(fingerprint_payload)`,
    chk_idempotency_status: `(status_code = 'P' AND result_payload IS NULL
      AND result_canonical_bytes IS NULL AND result_sha256 IS NULL
      AND completed_at IS NULL AND expires_at IS NULL)
      OR (status_code = 'C' AND result_payload IS NOT NULL
      AND result_canonical_bytes IS NOT NULL
      AND result_canonical_bytes BETWEEN 1 AND 33554432
      AND result_canonical_bytes = OCTET_LENGTH(result_payload)
      AND result_sha256 IS NOT NULL
      AND completed_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > completed_at)`,
  };
  if (
    actualChecks.size !== Object.keys(expectedChecks).length ||
    Object.keys(expectedChecks).some((name) => !actualChecks.has(name))
  )
    throw new Error('document replace idempotency check projection mismatch');
  for (const [name, clause] of Object.entries(expectedChecks)) {
    if (actualChecks.get(name) !== canonicalCheck(clause))
      throw new Error(`document replace idempotency check clause mismatch: ${name}`);
  }

  const actualIndex = indexes.map((row) => [
    row.indexName,
    Number(row.nonUnique),
    Number(row.sequence),
    row.columnName,
  ]);
  const expectedIndex = [
    ['uq_idempotency_scope', 0, 1, 'scope_code'],
    ['uq_idempotency_scope', 0, 2, 'principal_kind'],
    ['uq_idempotency_scope', 0, 3, 'principal_id'],
    ['uq_idempotency_scope', 0, 4, 'scope_subject'],
    ['uq_idempotency_scope', 0, 5, 'idempotency_key'],
  ];
  if (JSON.stringify(actualIndex) !== JSON.stringify(expectedIndex))
    throw new Error('document replace idempotency unique-key projection mismatch');
};

export const verifyDocumentReplaceIdempotencyPostcondition = async (
  connection: PoolConnection,
): Promise<void> => {
  const [columns] = await connection.query<DocumentReplaceIdempotencyColumnProjection[]>(
    `SELECT column_name AS columnName, column_type AS columnType, is_nullable AS isNullable
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'board_idempotency_records'
       AND column_name IN (
         'fingerprint_payload',
         'fingerprint_canonical_bytes',
         'result_payload',
         'result_canonical_bytes'
       )
     ORDER BY ordinal_position`,
  );
  const [checks] = await connection.query<DocumentReplaceIdempotencyCheckProjection[]>(
    `SELECT tc.constraint_name AS constraintName, cc.check_clause AS checkClause
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema = tc.constraint_schema
      AND cc.constraint_name = tc.constraint_name
     WHERE tc.table_schema = DATABASE()
       AND tc.table_name = 'board_idempotency_records'
       AND tc.constraint_name IN (
         'chk_idempotency_scope_shape',
         'chk_idempotency_fingerprint',
         'chk_idempotency_status'
       )
     ORDER BY tc.constraint_name`,
  );
  const [indexes] = await connection.query<DocumentReplaceIdempotencyIndexProjection[]>(
    `SELECT index_name AS indexName, non_unique AS nonUnique,
            seq_in_index AS sequence, column_name AS columnName
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'board_idempotency_records'
       AND index_name = 'uq_idempotency_scope'
     ORDER BY seq_in_index`,
  );
  assessDocumentReplaceIdempotencyPostcondition(columns, checks, indexes);
};
