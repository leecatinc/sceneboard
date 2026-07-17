import { AppError } from './app-error.js';

export type BoardPersistenceErrorCategory =
  | 'checkpoint_integrity'
  | 'row_integrity'
  | 'stored_result_integrity'
  | 'event_integrity'
  | 'capacity_exhausted';

export class BoardPersistenceError extends AppError {
  constructor(readonly category: BoardPersistenceErrorCategory, cause?: unknown) {
    super('INTERNAL_ERROR', cause === undefined ? undefined : { cause });
    this.name = 'BoardPersistenceError';
  }
}
