import { z } from 'zod';

import {
  ContentTextSchemaV1,
  HitlRequestIdSchemaV1,
  LocalFieldIdSchemaV1,
  ShortTextSchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';
import { scalarLengthV1 } from './json.js';
import {
  MAX_HITL_FIELDS,
  MAX_HITL_OPTIONS,
  MAX_HITL_TEXT_CHARS,
  MAX_MARKDOWN_CHARS,
} from './limits.js';

const HitlContentSchemaV1 = ContentTextSchemaV1.refine((value) => scalarLengthV1(value) <= MAX_MARKDOWN_CHARS, '[LIMIT:maxMarkdownChars] HITL body is too long');
const HitlTextValueSchemaV1 = ContentTextSchemaV1.refine((value) => scalarLengthV1(value) <= MAX_HITL_TEXT_CHARS, '[LIMIT:maxHitlTextChars] HITL text is too long');

export const HitlOptionSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    label: ShortTextSchemaV1,
    description: ShortTextSchemaV1.optional(),
  })
  .strict();

const uniqueOptions = (options: ReadonlyArray<{ id: string }>): boolean =>
  new Set(options.map((option) => option.id)).size === options.length;

const TextFieldSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('text'),
    label: ShortTextSchemaV1,
    required: z.boolean(),
    defaultValue: HitlTextValueSchemaV1.nullable(),
    minLength: z.number().int().safe().min(0).max(MAX_HITL_TEXT_CHARS),
    maxLength: z.number().int().safe().min(1).max(MAX_HITL_TEXT_CHARS),
  })
  .strict();
const NumberFieldSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('number'),
    label: ShortTextSchemaV1,
    required: z.boolean(),
    defaultValue: z.number().finite().nullable(),
    min: z.number().finite().nullable(),
    max: z.number().finite().nullable(),
  })
  .strict();
const BooleanFieldSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('boolean'),
    label: ShortTextSchemaV1,
    required: z.boolean(),
    defaultValue: z.boolean().nullable(),
  })
  .strict();
const SelectFieldSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('select'),
    label: ShortTextSchemaV1,
    required: z.boolean(),
    defaultValue: LocalFieldIdSchemaV1.nullable(),
    options: z.array(HitlOptionSchemaV1).min(1).max(MAX_HITL_OPTIONS),
  })
  .strict();

export const HitlFieldSchemaV1 = z.discriminatedUnion('type', [
  TextFieldSchemaV1,
  NumberFieldSchemaV1,
  BooleanFieldSchemaV1,
  SelectFieldSchemaV1,
]);

const InfoRequestSchemaV1 = z.object({ kind: z.literal('info'), title: ShortTextSchemaV1, body: HitlContentSchemaV1, acknowledgeLabel: ShortTextSchemaV1 }).strict();
const ChoiceRequestSchemaV1 = z.object({ kind: z.literal('choice'), title: ShortTextSchemaV1, body: HitlContentSchemaV1.optional(), multiple: z.boolean(), minSelections: z.number().int().safe().min(1).max(MAX_HITL_OPTIONS), maxSelections: z.number().int().safe().min(1).max(MAX_HITL_OPTIONS), options: z.array(HitlOptionSchemaV1).min(1).max(MAX_HITL_OPTIONS) }).strict();
const FormRequestSchemaV1 = z.object({ kind: z.literal('form'), title: ShortTextSchemaV1, body: HitlContentSchemaV1.optional(), fields: z.array(HitlFieldSchemaV1).min(1).max(MAX_HITL_FIELDS), submitLabel: ShortTextSchemaV1 }).strict();
const ConfirmationRequestSchemaV1 = z.object({ kind: z.literal('confirmation'), title: ShortTextSchemaV1, body: HitlContentSchemaV1, impact: z.enum(['standard', 'destructive']), confirmLabel: ShortTextSchemaV1, cancelLabel: ShortTextSchemaV1 }).strict();

export const HitlRequestDefinitionSchemaV1 = z
  .discriminatedUnion('kind', [InfoRequestSchemaV1, ChoiceRequestSchemaV1, FormRequestSchemaV1, ConfirmationRequestSchemaV1])
  .superRefine((definition, context) => {
    if (definition.kind === 'choice') {
      if (!uniqueOptions(definition.options)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'option IDs must be unique' });
      if (!definition.multiple && (definition.minSelections !== 1 || definition.maxSelections !== 1)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['minSelections'], message: 'single choice requires bounds of one' });
      if (definition.minSelections > definition.maxSelections || definition.maxSelections > definition.options.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['maxSelections'], message: 'selection bounds are invalid' });
    }
    if (definition.kind === 'form') {
      const ids = new Set<string>();
      definition.fields.forEach((field, index) => {
        if (ids.has(field.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'id'], message: 'field IDs must be unique' });
        ids.add(field.id);
        if (field.type === 'text') {
          if (field.minLength > field.maxLength) context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'maxLength'], message: 'text bounds are invalid' });
          if (field.defaultValue !== null) {
            const length = Array.from(field.defaultValue).length;
            if (length < field.minLength || length > field.maxLength) context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'defaultValue'], message: 'text default is outside bounds' });
          }
        } else if (field.type === 'number') {
          if (field.min !== null && field.max !== null && field.min > field.max) context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'max'], message: 'number bounds are invalid' });
          if (field.defaultValue !== null && ((field.min !== null && field.defaultValue < field.min) || (field.max !== null && field.defaultValue > field.max))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'defaultValue'], message: 'number default is outside bounds' });
        } else if (field.type === 'select') {
          if (!uniqueOptions(field.options)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'options'], message: 'option IDs must be unique' });
          if (field.defaultValue !== null && !field.options.some((option) => option.id === field.defaultValue)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'defaultValue'], message: 'select default is unknown' });
        }
      });
    }
  });

const InfoResponseSchemaV1 = z.object({ kind: z.literal('info'), acknowledged: z.literal(true) }).strict();
const ChoiceResponseSchemaV1 = z.object({ kind: z.literal('choice'), selectedOptionIds: z.array(LocalFieldIdSchemaV1).min(1).max(MAX_HITL_OPTIONS) }).strict();
const FormResponseSchemaV1 = z.object({ kind: z.literal('form'), values: z.record(LocalFieldIdSchemaV1, z.union([HitlTextValueSchemaV1, z.number().finite(), z.boolean(), z.null()])) }).strict();
const ConfirmationResponseSchemaV1 = z.object({ kind: z.literal('confirmation'), confirmed: z.boolean() }).strict();

export const HitlResponseSchemaV1 = z
  .discriminatedUnion('kind', [InfoResponseSchemaV1, ChoiceResponseSchemaV1, FormResponseSchemaV1, ConfirmationResponseSchemaV1])
  .superRefine((response, context) => {
    if (response.kind === 'choice' && new Set(response.selectedOptionIds).size !== response.selectedOptionIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['selectedOptionIds'], message: 'selected option IDs must be unique' });
    if (response.kind === 'form') {
      const count = Object.keys(response.values).length;
      if (count < 1 || count > MAX_HITL_FIELDS) context.addIssue({ code: z.ZodIssueCode.custom, path: ['values'], message: '[LIMIT:maxHitlFields] form value count is invalid' });
    }
  });

export type HitlFieldV1 = z.infer<typeof HitlFieldSchemaV1>;
export type HitlOptionV1 = z.infer<typeof HitlOptionSchemaV1>;
export type HitlRequestDefinitionV1 = z.infer<typeof HitlRequestDefinitionSchemaV1>;
export type HitlResponseV1 = z.infer<typeof HitlResponseSchemaV1>;

const validateResponseAgainstDefinition = (definition: HitlRequestDefinitionV1, response: HitlResponseV1): string | null => {
  if (definition.kind !== response.kind) return 'response kind does not match definition';
  if (definition.kind === 'choice' && response.kind === 'choice') {
    const known = new Set(definition.options.map((option) => option.id));
    if (response.selectedOptionIds.some((id) => !known.has(id))) return 'response contains an unknown option';
    if (response.selectedOptionIds.length < definition.minSelections || response.selectedOptionIds.length > definition.maxSelections) return 'response selection count is outside bounds';
  }
  if (definition.kind === 'form' && response.kind === 'form') {
    const keys = Object.keys(response.values);
    if (keys.length !== definition.fields.length || definition.fields.some((field) => !Object.hasOwn(response.values, field.id))) return 'form response keys do not match fields';
    for (const field of definition.fields) {
      const value = response.values[field.id];
      if (value === null) {
        if (field.required) return 'required form value is null';
        continue;
      }
      if (field.type === 'text') {
        if (typeof value !== 'string') return 'text field value has wrong type';
        const length = Array.from(value).length;
        if (length < field.minLength || length > field.maxLength) return 'text field value is outside bounds';
      } else if (field.type === 'number') {
        if (typeof value !== 'number') return 'number field value has wrong type';
        if ((field.min !== null && value < field.min) || (field.max !== null && value > field.max)) return 'number field value is outside bounds';
      } else if (field.type === 'boolean') {
        if (typeof value !== 'boolean') return 'boolean field value has wrong type';
      } else if (typeof value !== 'string' || !field.options.some((option) => option.id === value)) return 'select field value is unknown';
    }
  }
  return null;
};

export const HitlInteractionSchemaV1 = z
  .object({
    hitlRequestId: HitlRequestIdSchemaV1,
    definition: HitlRequestDefinitionSchemaV1,
    state: z.enum(['open', 'answered', 'superseded', 'expired', 'cancelled']),
    createdAt: TimestampSchemaV1,
    expiresAt: TimestampSchemaV1.nullable(),
    stateUpdatedAt: TimestampSchemaV1,
    response: HitlResponseSchemaV1.nullable(),
    answeredAt: TimestampSchemaV1.nullable(),
  })
  .strict()
  .superRefine((interaction, context) => {
    const created = Date.parse(interaction.createdAt);
    const updated = Date.parse(interaction.stateUpdatedAt);
    const expires = interaction.expiresAt === null ? null : Date.parse(interaction.expiresAt);
    const answered = interaction.answeredAt === null ? null : Date.parse(interaction.answeredAt);
    if (expires !== null && expires <= created) context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiry must follow creation' });
    if (interaction.state === 'open') {
      if (interaction.response !== null || interaction.answeredAt !== null || updated !== created) context.addIssue({ code: z.ZodIssueCode.custom, path: ['stateUpdatedAt'], message: 'open chronology is invalid' });
    } else if (interaction.state === 'answered') {
      if (interaction.response === null || answered === null || answered <= created || updated !== answered || (expires !== null && answered >= expires)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['answeredAt'], message: 'answered chronology is invalid' });
      else {
        const problem = validateResponseAgainstDefinition(interaction.definition, interaction.response);
        if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ['response'], message: problem });
      }
    } else if (interaction.state === 'expired') {
      if (interaction.response !== null || interaction.answeredAt !== null || expires === null || updated < expires) context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expired chronology is invalid' });
    } else if (interaction.response !== null || interaction.answeredAt !== null || updated <= created || (expires !== null && updated >= expires)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['stateUpdatedAt'], message: 'terminal chronology is invalid' });
  });

export const HitlRequestSuccessSchemaV1 = HitlInteractionSchemaV1.refine((interaction) => interaction.state === 'open', { path: ['state'], message: 'request success must be open' });
export const HitlRespondSuccessSchemaV1 = HitlInteractionSchemaV1.refine((interaction) => interaction.state === 'answered', { path: ['state'], message: 'respond success must be answered' });

export type HitlInteractionV1 = z.infer<typeof HitlInteractionSchemaV1>;
export type HitlRequestSuccessV1 = z.infer<typeof HitlRequestSuccessSchemaV1>;
export type HitlRespondSuccessV1 = z.infer<typeof HitlRespondSuccessSchemaV1>;
