import {
  HitlResponseParserV1,
  type HitlFieldV1,
  type HitlRequestDefinitionV1,
  type HitlResponseV1,
  type LocalFieldId,
} from '@leecat-board/board-schema';

export type HitlFormValueV1 = string | number | boolean | null;
export type HitlFormValuesV1 = Readonly<Record<string, HitlFormValueV1>>;
export type HitlFormErrorsV1 = Readonly<Record<string, string>>;

const scalarLength = (value: string): number => Array.from(value).length;

export const initialHitlFormValuesV1 = (
  definition: Extract<HitlRequestDefinitionV1, { kind: 'form' }>,
): Record<string, HitlFormValueV1> => Object.fromEntries(
  definition.fields.map((field) => [field.id, field.defaultValue]),
);

const validateField = (field: HitlFieldV1, value: HitlFormValueV1 | undefined): string | null => {
  if (value === null || value === undefined) return field.required ? `${field.label} is required.` : null;
  if (field.type === 'text') {
    if (typeof value !== 'string') return `${field.label} must be text.`;
    const length = scalarLength(value);
    if (length < field.minLength) return `${field.label} must contain at least ${field.minLength} characters.`;
    if (length > field.maxLength) return `${field.label} must contain no more than ${field.maxLength} characters.`;
    return null;
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${field.label} must be a number.`;
    if (field.min !== null && value < field.min) return `${field.label} must be at least ${field.min}.`;
    if (field.max !== null && value > field.max) return `${field.label} must be no more than ${field.max}.`;
    return null;
  }
  if (field.type === 'boolean') return typeof value === 'boolean' ? null : `${field.label} must be checked or cleared.`;
  return typeof value === 'string' && field.options.some((option) => option.id === value)
    ? null
    : `${field.label} must use one of the available options.`;
};

export const validateHitlFormV1 = (
  definition: Extract<HitlRequestDefinitionV1, { kind: 'form' }>,
  values: HitlFormValuesV1,
): { ok: true; response: Extract<HitlResponseV1, { kind: 'form' }> } | { ok: false; errors: HitlFormErrorsV1 } => {
  const errors: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of definition.fields) {
    const problem = validateField(field, values[field.id]);
    if (problem !== null) errors[field.id] = problem;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const response = {
    kind: 'form' as const,
    values: Object.fromEntries(definition.fields.map((field) => [field.id, values[field.id] ?? null])) as Record<LocalFieldId, HitlFormValueV1>,
  };
  const parsed = HitlResponseParserV1.parse(response);
  return parsed.ok && parsed.data.value.kind === 'form'
    ? { ok: true, response: parsed.data.value }
    : { ok: false, errors: { _form: 'The response could not be verified.' } };
};
