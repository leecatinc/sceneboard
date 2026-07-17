import type { PoolConnection } from 'mysql2/promise';

export type TransactionIsolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export const withTransaction = async <Value>(
  connection: PoolConnection,
  isolation: TransactionIsolation,
  operation: (connection: PoolConnection) => Promise<Value>,
): Promise<Value> => {
  await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
  await connection.beginTransaction();
  try {
    const value = await operation(connection);
    await connection.commit();
    return value;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'transaction and rollback both failed');
    }
    throw error;
  }
};
