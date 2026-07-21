const MYSQL_MILLISECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const MYSQL_ZERO_MILLISECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const parseMysqlTimestampUtc = (value: string): Date => {
  const canonical = MYSQL_MILLISECOND_TIMESTAMP.test(value)
    ? value
    : MYSQL_ZERO_MILLISECOND_TIMESTAMP.test(value)
      ? `${value}.000`
      : null;
  if (canonical === null) throw new TypeError('MySQL timestamp must have millisecond precision');
  const parsed = new Date(`${canonical.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed.valueOf()) || formatMysqlTimestampUtc(parsed) !== canonical) {
    throw new TypeError('MySQL timestamp is not a valid UTC instant');
  }
  return parsed;
};

export const formatMysqlTimestampUtc = (value: Date): string => {
  if (!Number.isFinite(value.valueOf())) throw new TypeError('timestamp must be a valid date');
  return value.toISOString().replace('T', ' ').replace('Z', '');
};

export const formatProtocolTimestampUtcForMysql = (value: string): string => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError('protocol timestamp must be canonical UTC with millisecond precision');
  }
  return formatMysqlTimestampUtc(parsed);
};
