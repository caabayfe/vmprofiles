import type { ReactNode } from 'react'
import { Checkbox, Field, Input, TextArea, T } from '@nttdsp/react-components'

interface BaseProps {
  label: string
  required?: boolean
  help?: string
  disabled?: boolean
}

export function TextField({
  label, value, onChange, required, help, disabled, placeholder,
}: BaseProps & { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Field label={label} required={required} help={help}>
      <Input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e: { target: { value: string } }) => onChange(e.target.value)}
      />
    </Field>
  )
}

export function NumberField({
  label, value, onChange, required, help, disabled, min,
}: BaseProps & { value: number | null; onChange: (v: number | null) => void; min?: number }) {
  return (
    <Field label={label} required={required} help={help}>
      <Input
        type="number"
        min={min}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e: { target: { value: string } }) =>
          onChange(e.target.value === '' ? null : Number(e.target.value))
        }
      />
    </Field>
  )
}

export function TextAreaField({
  label, value, onChange, required, help, disabled,
}: BaseProps & { value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} required={required} help={help}>
      <TextArea
        value={value}
        disabled={disabled}
        onChange={(e: { target: { value: string } }) => onChange(e.target.value)}
      />
    </Field>
  )
}

export interface Option {
  value: string
  label: string
}

/** Short fixed lists use a native select (frontend guide §3 "UI patterns"). */
export function SelectField({
  label, value, options, onChange, required, help, disabled, allowEmpty = true, emptyLabel,
}: BaseProps & {
  value: string | null
  options: Option[]
  onChange: (v: string | null) => void
  allowEmpty?: boolean
  emptyLabel?: string
}) {
  return (
    <Field label={label} required={required} help={help}>
      <select
        className="form-control"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        {allowEmpty && <option value="">{emptyLabel ?? T.SELECT_PLACEHOLDER}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function CheckboxField({
  name, label, checked, onChange, disabled,
}: { name: string; label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Checkbox
      name={name}
      label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e: { target: { value: unknown } }) => onChange(!!e.target.value)}
    />
  )
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  return <p className="vp-error" role="alert">{msg}</p>
}
