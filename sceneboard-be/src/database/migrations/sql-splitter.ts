export type SqlSplitErrorReason =
  | 'empty_script'
  | 'delimiter_directive'
  | 'executable_comment'
  | 'nul_byte'
  | 'unterminated_quote'
  | 'unterminated_comment';

export class SqlSplitError extends Error {
  constructor(readonly reason: SqlSplitErrorReason) {
    super(`Invalid migration SQL: ${reason}`);
    this.name = 'SqlSplitError';
  }
}

type LexerState = 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment';

export const splitSqlStatements = (source: string): string[] => {
  if (source.trim() === '') throw new SqlSplitError('empty_script');
  if (source.includes('\0')) throw new SqlSplitError('nul_byte');
  if (/^\s*DELIMITER\b/im.test(source)) throw new SqlSplitError('delimiter_directive');
  if (/\/\*[!+]/.test(source)) throw new SqlSplitError('executable_comment');

  const statements: string[] = [];
  let buffer = '';
  let state: LexerState = 'normal';
  let escaped = false;

  const push = (): void => {
    const statement = buffer.trim();
    if (statement !== '') statements.push(statement);
    buffer = '';
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') {
        state = 'normal';
        buffer += ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'normal';
        buffer += ' ';
        index += 1;
      }
      continue;
    }
    if (state !== 'normal') {
      buffer += character;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (
        (state === 'single' && character === "'") ||
        (state === 'double' && character === '"') ||
        (state === 'backtick' && character === '`')
      )
        state = 'normal';
      continue;
    }

    if (character === '-' && next === '-') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '#') {
      state = 'line-comment';
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (character === "'") state = 'single';
    else if (character === '"') state = 'double';
    else if (character === '`') state = 'backtick';
    else if (character === ';') {
      push();
      continue;
    }
    buffer += character;
  }

  if (state === 'block-comment') throw new SqlSplitError('unterminated_comment');
  if (state === 'single' || state === 'double' || state === 'backtick')
    throw new SqlSplitError('unterminated_quote');
  if (buffer.trim() !== '') push();
  if (statements.length === 0) throw new SqlSplitError('empty_script');
  return statements;
};
