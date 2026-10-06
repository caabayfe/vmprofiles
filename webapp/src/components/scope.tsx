import { useEffect, useState } from 'react'
import { Badge, BaseTable, Button, Field, Input, Modal, T } from '@nttdsp/react-components'
import { useQueryClient } from '@tanstack/react-query'
import { api, searchCompanies, type DfCompany, type UUID } from '../api'
import { manageableScopes, useCompanies, useMe } from '../hooks'
import type { CompanyType } from '../types'
import { ErrorText, SelectField } from './fields'

export const GLOBAL = 'global'

export function ScopeBadge({ companyName }: { companyName: string | null | undefined }) {
  return companyName ? (
    <Badge appearance="info">{companyName}</Badge>
  ) : (
    <Badge appearance="secondary">{T.SCOPE_GLOBAL}</Badge>
  )
}

/** List-page filter: All / Global / one company. Value is 'all' | 'global' | uuid. */
export function ScopeFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: me } = useMe()
  const { data: companies } = useCompanies(!!me?.is_global_admin)
  const list = me?.is_global_admin ? companies ?? [] : me?.companies ?? []
  return (
    <SelectField
      label={T.SCOPE_FILTER}
      value={value}
      allowEmpty={false}
      onChange={(v) => onChange(v ?? 'all')}
      options={[
        { value: 'all', label: T.SCOPE_ALL },
        { value: GLOBAL, label: T.SCOPE_GLOBAL_ONLY },
        ...list.map((c) => ({ value: c.id, label: c.name })),
      ]}
    />
  )
}

function useDebounced<V>(value: V, delay = 300): V {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}

/** Global admins pick any Digital Fabric company; it is cached via POST /companies. */
export function CompanySearchModal({
  show, onClose, onPicked,
}: { show: boolean; onClose: () => void; onPicked: (c: CompanyType) => void }) {
  const qc = useQueryClient()
  const [term, setTerm] = useState('')
  const debounced = useDebounced(term)
  const [rows, setRows] = useState<DfCompany[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let live = true
    if (!debounced.trim()) {
      setRows([])
      return
    }
    setLoading(true)
    searchCompanies(debounced)
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [debounced])

  const pick = async (c: DfCompany) => {
    try {
      const saved = await api.post<CompanyType>('/companies', { id: c.id, name: c.name, code: c.code ?? '' })
      await qc.invalidateQueries({ queryKey: ['companies'] })
      onPicked(saved)
      onClose()
    } catch (e) {
      setError(e)
    }
  }

  return (
    <Modal show={show} handleClose={onClose} title={T.COMPANY_SEARCH_TITLE} size="m">
      <Field label={T.COMPANY_SEARCH_LABEL}>
        <Input value={term} autoFocus onChange={(e: { target: { value: string } }) => setTerm(e.target.value)} />
      </Field>
      <ErrorText error={error} />
      <div style={{ height: 360, overflowY: 'auto', marginTop: 12 }}>
        <BaseTable
          columns={[
            { accessor: 'name', Header: T.COL_NAME, visible: true },
            { accessor: 'code', Header: T.COL_CODE, visible: true },
          ]}
          data={rows as unknown as Record<string, unknown>[]}
          loading={loading}
          noDataMessage={term ? T.NO_RESULTS : T.TYPE_TO_SEARCH}
          rowActions={[{ id: 'pick', label: T.ACTION_SELECT, onSelect: (_e: unknown, { row }: { row: DfCompany }) => pick(row) }]}
        />
      </div>
    </Modal>
  )
}

/** Form control: Global or a company the caller can manage. */
export function ScopeSelect({
  value, onChange, disabled, label,
}: { value: UUID | null; onChange: (v: UUID | null) => void; disabled?: boolean; label?: string }) {
  const { data: me } = useMe()
  const { data: companies } = useCompanies(!!me?.is_global_admin)
  const scopes = manageableScopes(me, companies)
  const [searching, setSearching] = useState(false)
  const options = [
    ...(scopes.allowGlobal ? [{ value: GLOBAL, label: T.SCOPE_GLOBAL_OPTION }] : []),
    ...scopes.companies.map((c) => ({ value: c.id, label: c.name })),
  ]
  // A company admin with exactly one company never sees a choice.
  useEffect(() => {
    if (!disabled && !scopes.allowGlobal && value === null && scopes.companies.length === 1) {
      onChange(scopes.companies[0].id)
    }
  }, [disabled, scopes.allowGlobal, scopes.companies, value, onChange])

  return (
    <div className="vp-grid-row" style={{ gridTemplateColumns: me?.is_global_admin && !disabled ? '1fr auto' : '1fr' }}>
      <SelectField
        label={label ?? T.FIELD_SCOPE}
        required
        disabled={disabled}
        value={value ?? (scopes.allowGlobal ? GLOBAL : null)}
        options={options}
        allowEmpty={!scopes.allowGlobal}
        onChange={(v) => onChange(v === GLOBAL ? null : v)}
      />
      {me?.is_global_admin && !disabled && (
        <>
          <Button appearance="neutral" onClick={() => setSearching(true)}>
            {T.ACTION_FIND_COMPANY}
          </Button>
          <CompanySearchModal show={searching} onClose={() => setSearching(false)} onPicked={(c) => onChange(c.id)} />
        </>
      )}
    </div>
  )
}
