'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  BoardId,
  HitlInteractionV1,
  HitlResponseV1,
  RevisionId,
} from '@leecat-board/board-schema';

import type { HitlInteractionControllerV1 } from './hitl-controller.js';
import {
  initialHitlFormValuesV1,
  validateHitlFormV1,
  type HitlFormErrorsV1,
  type HitlFormValueV1,
} from './hitl-form-validation.js';

const SECRET_WARNING = 'Do not enter passwords, API keys, private keys, recovery codes, or authentication secrets.';

type OpenProps = {
  interaction: HitlInteractionV1;
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  controller: HitlInteractionControllerV1;
  idPrefix: string;
};

const intent = (
  props: OpenProps,
  response: HitlResponseV1,
) => ({
  boardId: props.boardId,
  expectedRevisionId: props.expectedRevisionId,
  hitlRequestId: props.interaction.hitlRequestId,
  response,
});

const SecretWarning = ({ id }: { id: string }) => <p id={id} className="hitl-secret-warning" role="note">{SECRET_WARNING}</p>;

function InfoResponse(props: OpenProps) {
  const definition = props.interaction.definition;
  if (definition.kind !== 'info') return null;
  return (
    <div className="hitl-controls">
      <button
        type="button"
        disabled={props.controller.isSubmitting(props.interaction.hitlRequestId)}
        onClick={() => void props.controller.submit(intent(props, { kind: 'info', acknowledged: true }))}
      >{definition.acknowledgeLabel}</button>
    </div>
  );
}

function ChoiceResponse(props: OpenProps) {
  const definition = props.interaction.definition;
  const [selected, setSelected] = useState<string[]>([]);
  if (definition.kind !== 'choice') return null;
  const valid = selected.length >= definition.minSelections && selected.length <= definition.maxSelections;
  const toggle = (optionId: string, checked: boolean): void => {
    setSelected((current) => definition.multiple
      ? checked ? [...current, optionId] : current.filter((id) => id !== optionId)
      : [optionId]);
  };
  return (
    <div className="hitl-controls">
      <SecretWarning id={`${props.idPrefix}-secret-warning`} />
      <fieldset aria-describedby={`${props.idPrefix}-choice-help ${props.idPrefix}-secret-warning`}>
        <legend>{definition.multiple ? 'Choose one or more' : 'Choose one'}</legend>
        {definition.options.map((option) => (
          <label key={option.id} className="hitl-option">
            <input
              type={definition.multiple ? 'checkbox' : 'radio'}
              name={`${props.idPrefix}-choice`}
              value={option.id}
              checked={selected.includes(option.id)}
              onChange={(event) => toggle(option.id, event.currentTarget.checked)}
            />
            <span><strong>{option.label}</strong>{option.description !== undefined && <small>{option.description}</small>}</span>
          </label>
        ))}
      </fieldset>
      <p id={`${props.idPrefix}-choice-help`} className="scene-help" aria-live="polite">
        {selected.length} selected · minimum {definition.minSelections}, maximum {definition.maxSelections}
      </p>
      <button
        type="button"
        disabled={!valid || props.controller.isSubmitting(props.interaction.hitlRequestId)}
        onClick={() => void props.controller.submit(intent(props, { kind: 'choice', selectedOptionIds: selected as never }))}
      >Submit response</button>
    </div>
  );
}

function FormResponse(props: OpenProps) {
  const definition = props.interaction.definition;
  if (definition.kind !== 'form') return null;
  return <VerifiedFormResponse {...props} definition={definition} />;
}

function VerifiedFormResponse(props: OpenProps & {
  definition: Extract<HitlInteractionV1['definition'], { kind: 'form' }>;
}) {
  const [values, setValues] = useState<Record<string, HitlFormValueV1>>(() => initialHitlFormValuesV1(props.definition));
  const [errors, setErrors] = useState<HitlFormErrorsV1>({});
  const [announcement, setAnnouncement] = useState('');
  const controls = useRef<Record<string, HTMLInputElement | HTMLSelectElement | null>>({});
  const setValue = (fieldId: string, value: HitlFormValueV1): void => {
    setValues((current) => ({ ...current, [fieldId]: value }));
    setErrors((current) => {
      if (!Object.hasOwn(current, fieldId)) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const checked = validateHitlFormV1(props.definition, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      setAnnouncement('Check the highlighted fields and try again.');
      const first = props.definition.fields.find((field) => Object.hasOwn(checked.errors, field.id));
      if (first !== undefined) controls.current[first.id]?.focus();
      return;
    }
    setErrors({});
    setAnnouncement('');
    void props.controller.submit(intent(props, checked.response));
  };
  return (
    <form className="hitl-controls hitl-form" noValidate onSubmit={submit}>
      <SecretWarning id={`${props.idPrefix}-secret-warning`} />
      {props.definition.fields.map((field) => {
        const value = values[field.id];
        const errorId = `${props.idPrefix}-${field.id}-error`;
        const describedBy = errors[field.id] === undefined ? `${props.idPrefix}-secret-warning` : `${props.idPrefix}-secret-warning ${errorId}`;
        const common = {
          id: `${props.idPrefix}-${field.id}`,
          'aria-invalid': errors[field.id] === undefined ? undefined : true,
          'aria-describedby': describedBy,
        } as const;
        return (
          <div key={field.id} className="hitl-field">
            {field.type === 'boolean' ? (
              <label className="hitl-boolean" htmlFor={common.id}>
                <input
                  {...common}
                  ref={(element) => { controls.current[field.id] = element; }}
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => setValue(field.id, event.currentTarget.checked)}
                />
                <span>{field.label}{field.required && <span aria-label="required"> *</span>}</span>
              </label>
            ) : (
              <label htmlFor={common.id}>{field.label}{field.required && <span aria-label="required"> *</span>}</label>
            )}
            {field.type === 'text' && (
              <input
                {...common}
                ref={(element) => { controls.current[field.id] = element; }}
                type="text"
                required={field.required}
                minLength={field.minLength}
                maxLength={field.maxLength}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => setValue(field.id, event.currentTarget.value === '' && !field.required ? null : event.currentTarget.value)}
              />
            )}
            {field.type === 'number' && (
              <input
                {...common}
                ref={(element) => { controls.current[field.id] = element; }}
                type="number"
                required={field.required}
                {...(field.min === null ? {} : { min: field.min })}
                {...(field.max === null ? {} : { max: field.max })}
                value={typeof value === 'number' ? value : ''}
                onChange={(event) => {
                  const number = event.currentTarget.valueAsNumber;
                  setValue(field.id, event.currentTarget.value === '' || !Number.isFinite(number) ? null : number);
                }}
              />
            )}
            {field.type === 'select' && (
              <select
                {...common}
                ref={(element) => { controls.current[field.id] = element; }}
                required={field.required}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => setValue(field.id, event.currentTarget.value === '' ? null : event.currentTarget.value)}
              >
                <option value="">Select an option</option>
                {field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            )}
            {errors[field.id] !== undefined && <p id={errorId} className="hitl-field-error">{errors[field.id]}</p>}
          </div>
        );
      })}
      <p className="hitl-validation-summary" role="alert">{announcement}</p>
      <button type="submit" disabled={props.controller.isSubmitting(props.interaction.hitlRequestId)}>{props.definition.submitLabel}</button>
    </form>
  );
}

function ConfirmationResponse(props: OpenProps) {
  const definition = props.interaction.definition;
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => setReviewed(false), [
    props.boardId,
    props.expectedRevisionId,
    props.interaction.hitlRequestId,
    props.interaction.stateUpdatedAt,
    props.controller.mode,
  ]);
  if (definition.kind !== 'confirmation') return null;
  const submitting = props.controller.isSubmitting(props.interaction.hitlRequestId);
  const answer = (confirmed: boolean): void => {
    void props.controller.submit(intent(props, { kind: 'confirmation', confirmed }));
  };
  return (
    <div className={`hitl-controls hitl-confirmation ${definition.impact === 'destructive' ? 'hitl-destructive' : ''}`}>
      {definition.impact === 'destructive' && (
        <p className="hitl-impact-warning"><span aria-hidden="true">⚠</span> This action may be irreversible. Nothing happens unless you explicitly confirm.</p>
      )}
      <SecretWarning id={`${props.idPrefix}-secret-warning`} />
      <div className="hitl-actions" aria-describedby={`${props.idPrefix}-secret-warning`}>
        <button type="button" disabled={submitting} onClick={() => answer(false)}>{definition.cancelLabel}</button>
        {definition.impact === 'standard' && (
          <button type="button" disabled={submitting} onClick={() => answer(true)}>{definition.confirmLabel}</button>
        )}
        {definition.impact === 'destructive' && !reviewed && (
          <button type="button" disabled={submitting} onClick={() => setReviewed(true)}>Review impact</button>
        )}
        {definition.impact === 'destructive' && reviewed && (
          <button type="button" className="hitl-danger-button" disabled={submitting} onClick={() => answer(true)}>
            <span aria-hidden="true">⚠</span> {definition.confirmLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export function HitlOpenContent(props: OpenProps) {
  const definition = props.interaction.definition;
  return (
    <>
      <p className="hitl-kind-label">{
        definition.kind === 'info' ? 'Information'
          : definition.kind === 'choice' ? definition.multiple ? 'Choose one or more' : 'Choose one'
            : definition.kind === 'form' ? 'Provide details'
              : definition.impact === 'destructive' ? 'Destructive confirmation required' : 'Confirmation required'
      }</p>
      {'body' in definition && definition.body !== undefined && <p className="hitl-body">{definition.body}</p>}
      {definition.kind === 'info' && <InfoResponse {...props} />}
      {definition.kind === 'choice' && <ChoiceResponse {...props} />}
      {definition.kind === 'form' && <FormResponse {...props} />}
      {definition.kind === 'confirmation' && <ConfirmationResponse {...props} />}
    </>
  );
}
