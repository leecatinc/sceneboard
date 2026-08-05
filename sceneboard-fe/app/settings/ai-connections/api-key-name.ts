const twoDigits = (value: number): string => String(value).padStart(2, '0');

export const formatApiKeyNameTimestamp = (date: Date): string =>
  `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
