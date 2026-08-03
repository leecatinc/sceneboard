import type { PoolConnection } from 'mysql2/promise';

export type TransactionIsolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export type DatabaseOperationOwnershipV1 = Readonly<{
  signal: AbortSignal;
  deadlineMs: number;
  cleanupGraceMs?: number;
}>;

export class DatabaseOperationAbortedError extends Error {
  constructor() {
    super('database operation exceeded its owned deadline');
    this.name = 'DatabaseOperationAbortedError';
  }
}

export const awaitOwnedDatabaseOperation = <Value>(
  operation: Promise<Value>,
  ownership?: DatabaseOperationOwnershipV1,
  releaseLateResult?: (value: Value) => void | Promise<void>,
): Promise<Value> => {
  if (ownership === undefined) return operation;
  return new Promise((resolve, reject) => {
    let terminal = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      ownership.signal.removeEventListener('abort', aborted);
    };
    const fail = (): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      reject(new DatabaseOperationAbortedError());
    };
    const aborted = (): void => fail();
    const timeout = setTimeout(fail, Math.max(1, ownership.deadlineMs - Date.now()));
    timeout.unref();
    ownership.signal.addEventListener('abort', aborted, { once: true });
    if (ownership.signal.aborted || Date.now() >= ownership.deadlineMs) fail();
    void operation.then(
      (value) => {
        if (terminal) {
          if (releaseLateResult !== undefined)
            void Promise.resolve()
              .then(() => releaseLateResult(value))
              .catch((error: unknown) => {
                process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
                  code: 'SCENEBOARD_DATABASE_CLEANUP_FAILED',
                });
              });
          return;
        }
        terminal = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (terminal) return;
        terminal = true;
        cleanup();
        reject(error);
      },
    );
  });
};

const awaitRollback = async (rollback: Promise<void>, cleanupGraceMs: number): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      rollback,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('database rollback exceeded its cleanup grace period')),
          cleanupGraceMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

export const withTransaction = async <Value>(
  connection: PoolConnection,
  isolation: TransactionIsolation,
  operation: (connection: PoolConnection) => Promise<Value>,
  ownership?: DatabaseOperationOwnershipV1,
): Promise<Value> => {
  await awaitOwnedDatabaseOperation(
    connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`),
    ownership,
  );
  await awaitOwnedDatabaseOperation(connection.beginTransaction(), ownership);
  try {
    const value = await awaitOwnedDatabaseOperation(operation(connection), ownership);
    await awaitOwnedDatabaseOperation(connection.commit(), ownership);
    return value;
  } catch (error) {
    try {
      await awaitRollback(connection.rollback(), ownership?.cleanupGraceMs ?? 1_000);
    } catch (rollbackError) {
      if (error instanceof DatabaseOperationAbortedError) throw error;
      throw new AggregateError([error, rollbackError], 'transaction and rollback both failed');
    }
    throw error;
  }
};
