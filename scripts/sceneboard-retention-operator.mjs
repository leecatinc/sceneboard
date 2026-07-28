import process from 'node:process';

import mysql from 'mysql2/promise';

const [command, boardPk, option] = process.argv.slice(2);
if (
  !['status', 'dry-run', 'resume'].includes(command ?? '') ||
  !/^[1-9][0-9]*$/u.test(boardPk ?? '')
) {
  throw new Error(
    'usage: sceneboard-retention-operator.mjs <status|dry-run|resume> <board-pk> [recovery-id]',
  );
}
const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  timezone: 'Z',
});
try {
  if (command === 'status') {
    const [rows] = await connection.execute(
      `SELECT recovery_id AS recoveryId, CAST(revision_pk AS CHAR) AS revisionPk,
              phase, attempts, last_error AS lastError, lease_owner AS owner
       FROM board_revision_recovery
       WHERE board_pk = ?
       ORDER BY updated_at DESC, recovery_id DESC LIMIT 100`,
      [boardPk],
    );
    process.stdout.write(`${JSON.stringify({ command, boardPk, rows }, null, 2)}\n`);
  } else if (command === 'dry-run') {
    const retainedCount = Number(process.env.REVISION_RETENTION_COUNT ?? '32');
    const [rows] = await connection.execute(
      `SELECT CAST(r.revision_pk AS CHAR) AS revisionPk,
              CAST(r.revision_number AS CHAR) AS revisionNumber,
              p.stored_bytes AS storedBytes
       FROM board_revision_catalog c
       JOIN board_revisions r ON r.board_pk=c.board_pk AND r.revision_pk=c.revision_pk
       JOIN board_revision_payloads p ON p.revision_pk=r.revision_pk
       WHERE c.board_pk=? AND c.is_head=0
         AND c.retained_order <= (
           SELECT IF(COUNT(*)>?,MAX(n.retained_order)-?,0) FROM board_revision_catalog n
           WHERE n.board_pk=c.board_pk
         )
         AND NOT EXISTS (
           SELECT 1 FROM board_revision_holds h
           WHERE h.board_pk=c.board_pk AND h.revision_pk=c.revision_pk
             AND h.released_at IS NULL
             AND (h.expires_at IS NULL OR h.expires_at>CURRENT_TIMESTAMP(3))
         )
       ORDER BY r.revision_pk ASC LIMIT 100`,
      [boardPk, retainedCount, retainedCount],
    );
    process.stdout.write(`${JSON.stringify({ command, boardPk, rows }, null, 2)}\n`);
  } else {
    if (!/^[A-Za-z0-9:_-]{3,191}$/u.test(option ?? '')) throw new Error('invalid recovery id');
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `UPDATE board_revision_recovery
       SET phase='planned', attempts=0, last_error=NULL, updated_at=CURRENT_TIMESTAMP(3)
       WHERE recovery_id=? AND board_pk=? AND phase='quarantined'`,
      [option, boardPk],
    );
    if (result.affectedRows !== 1) throw new Error('recovery is absent or not quarantined');
    await connection.commit();
    process.stdout.write(`${JSON.stringify({ command, boardPk, recoveryId: option })}\n`);
  }
} catch (error) {
  await connection.rollback().catch(() => undefined);
  throw error;
} finally {
  await connection.end();
}
