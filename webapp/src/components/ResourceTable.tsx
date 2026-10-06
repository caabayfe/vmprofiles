import { useState, type ReactNode } from 'react'
import { Badge, BaseTable, Button, Modal, T } from '@nttdsp/react-components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type UUID } from '../api'
import { canManage, useMe } from '../hooks'
import type { Row } from '../types'
import { ConfirmModal, type ConfirmState } from './ConfirmModal'
import { ErrorText, NumberField, SelectField, TextAreaField, TextField, type Option } from './fields'
import { ScopeBadge, ScopeSelect } from './scope'

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'textarea' | 'select' | 'scope'
  required?: boolean
  options?: Option[]
  help?: string
  /** Cannot change after create (scope / parent ids). */
  immutable?: boolean
}

export interface ColumnDef {
  accessor: string
  Header: string
  Cell?: (props: { value: unknown; row: Row }) => ReactNode
  width?: string
}

export interface RowAction {
  id: string
  label: string
  visible?: (row: Row) => boolean
  onSelect: (row: Row) => void
}

export interface ResourceConfig {
  path: string
  queryKey: string
  singular: string
  columns: ColumnDef[]
  fields: FieldDef[]
  /** Rows carry their own company_id (software / roles / sizes / vCenters). */
  scoped?: boolean
  defaults?: Row
}

interface Props {
  config: ResourceConfig
  /** Query params (scope filter, parent ids). */
  params?: Record<string, string | null | undefined>
  /** Values injected into every create payload (e.g. vcenter_id). */
  fixed?: Row
  /** Owning company for permission checks when rows have no company of their own. */
  ownerCompanyId?: UUID | null
  showArchived?: boolean
  extraActions?: RowAction[]
  afterSave?: (saved: Row, form: Row) => Promise<void>
  extraForm?: (form: Row, set: (k: string, v: unknown) => void) => ReactNode
  addLabel?: string
}

export function useResourceList(config: ResourceConfig, params?: Props['params'], includeArchived = false) {
  return useQuery({
    queryKey: [config.queryKey, params ?? {}, includeArchived],
    queryFn: () => api.get<Row[]>(config.path, { ...params, include_archived: includeArchived || undefined }),
  })
}

export function ResourceTable({
  config, params, fixed, ownerCompanyId, showArchived = false, extraActions = [], afterSave, extraForm, addLabel,
}: Props) {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const { data, isLoading, error } = useResourceList(config, params, showArchived)
  const [editing, setEditing] = useState<{ id: UUID | null; form: Row } | null>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const rowCompany = (row: Row): UUID | null =>
    (config.scoped ? (row.company_id as UUID | null) : (row.owner_company_id as UUID | null)) ?? null
  const canAdd = config.scoped ? !!me?.is_admin : canManage(me, ownerCompanyId ?? null)
  const refresh = () => qc.invalidateQueries({ queryKey: [config.queryKey] })

  const openNew = () => {
    setSaveError(null)
    const scopeDefault = config.scoped ? { company_id: me?.is_global_admin ? null : undefined } : {}
    setEditing({ id: null, form: { ...config.defaults, ...scopeDefault, ...fixed } })
  }
  const openEdit = (row: Row) => {
    setSaveError(null)
    setEditing({ id: row.id as UUID, form: { ...row } })
  }
  const set = (k: string, v: unknown) => setEditing((e) => (e ? { ...e, form: { ...e.form, [k]: v } } : e))

  const save = async () => {
    if (!editing) return
    setBusy(true)
    setSaveError(null)
    try {
      const payload: Row = { ...fixed }
      for (const f of config.fields) payload[f.key] = editing.form[f.key] ?? null
      for (const [k, v] of Object.entries(payload)) if (v === null && k !== 'company_id') delete payload[k]
      const saved = editing.id
        ? await api.put<Row>(`${config.path}/${editing.id}`, payload)
        : await api.post<Row>(config.path, payload)
      if (afterSave) await afterSave(saved, editing.form)
      await refresh()
      await qc.invalidateQueries({ queryKey: ['lookups'] })
      setEditing(null)
    } catch (e) {
      setSaveError(e)
    } finally {
      setBusy(false)
    }
  }

  const act = (path: string, method: 'post' | 'del') => async () => {
    if (method === 'post') await api.post(path)
    else await api.del(path)
    await refresh()
    await qc.invalidateQueries({ queryKey: ['lookups'] })
  }

  const columns = [
    ...config.columns.map((c) => ({ ...c, visible: true })),
    ...(config.scoped
      ? [{
          accessor: 'company_id', Header: T.COL_SCOPE, visible: true,
          Cell: ({ row }: { row: Row }) => (
            <ScopeBadge companyName={row.owner_company_name as string | null} />
          ),
        }]
      : []),
    {
      accessor: 'is_active', Header: T.COL_STATUS, visible: true, width: '110px',
      Cell: ({ value }: { value: unknown }) =>
        value ? <Badge appearance="success">{T.STATUS_ACTIVE}</Badge> : <Badge appearance="secondary">{T.STATUS_ARCHIVED}</Badge>,
    },
  ]

  const manageable = (row: Row) => canManage(me, rowCompany(row))
  const rowActions = [
    { id: 'edit', label: T.ACTION_EDIT, visible: ({ row }: { row: Row }) => manageable(row),
      onSelect: (_e: unknown, { row }: { row: Row }) => openEdit(row) },
    ...extraActions.map((a) => ({
      id: a.id, label: a.label,
      visible: ({ row }: { row: Row }) => (a.visible ? a.visible(row) : true) && manageable(row),
      onSelect: (_e: unknown, { row }: { row: Row }) => a.onSelect(row),
    })),
    { id: 'archive', label: T.ACTION_ARCHIVE, visible: ({ row }: { row: Row }) => manageable(row) && !!row.is_active,
      onSelect: (_e: unknown, { row }: { row: Row }) => setConfirm({
        title: T.CONFIRM_ARCHIVE_TITLE, body: T.CONFIRM_ARCHIVE_BODY, confirmLabel: T.ACTION_ARCHIVE,
        action: act(`${config.path}/${row.id}/archive`, 'post'),
      }) },
    { id: 'restore', label: T.ACTION_RESTORE, visible: ({ row }: { row: Row }) => manageable(row) && !row.is_active,
      onSelect: (_e: unknown, { row }: { row: Row }) => act(`${config.path}/${row.id}/restore`, 'post')() },
    { id: 'delete', label: T.ACTION_DELETE, visible: ({ row }: { row: Row }) => manageable(row),
      onSelect: (_e: unknown, { row }: { row: Row }) => setConfirm({
        title: T.CONFIRM_DELETE_TITLE, body: T.CONFIRM_DELETE_BODY, confirmLabel: T.ACTION_DELETE, danger: true,
        action: act(`${config.path}/${row.id}`, 'del'),
      }) },
  ]

  const renderField = (f: FieldDef) => {
    const form = editing?.form ?? {}
    const locked = !!(f.immutable && editing?.id)
    const common = { label: f.label, required: f.required, help: f.help, disabled: locked }
    switch (f.type) {
      case 'scope':
        return <ScopeSelect key={f.key} value={(form[f.key] as UUID | null) ?? null} disabled={locked} onChange={(v) => set(f.key, v)} />
      case 'number':
        return <NumberField key={f.key} {...common} value={(form[f.key] as number | null) ?? null} onChange={(v) => set(f.key, v)} />
      case 'textarea':
        return <TextAreaField key={f.key} {...common} value={(form[f.key] as string) ?? ''} onChange={(v) => set(f.key, v)} />
      case 'select':
        return <SelectField key={f.key} {...common} value={(form[f.key] as string | null) ?? null} options={f.options ?? []} onChange={(v) => set(f.key, v)} />
      default:
        return <TextField key={f.key} {...common} value={(form[f.key] as string) ?? ''} onChange={(v) => set(f.key, v)} />
    }
  }

  return (
    <>
      {canAdd && (
        <div className="vp-actions" style={{ marginTop: 0, marginBottom: 12 }}>
          <Button appearance="primary" onClick={openNew}>{addLabel ?? T.ACTION_ADD}</Button>
        </div>
      )}
      <ErrorText error={error} />
      <BaseTable
        columns={columns}
        data={data ?? []}
        loading={isLoading}
        noDataMessage={T.NO_DATA}
        rowActions={rowActions}
      />
      <Modal
        show={!!editing}
        handleClose={() => setEditing(null)}
        title={`${editing?.id ? T.ACTION_EDIT : T.ACTION_ADD} — ${config.singular}`}
        size="m"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button appearance="neutral" onClick={() => setEditing(null)}>{T.ACTION_CANCEL}</Button>
            <Button appearance="primary" onClick={save} disabled={busy}>{T.ACTION_SAVE}</Button>
          </div>
        }
      >
        <div className="vp-form">
          {config.fields.map(renderField)}
          {editing && extraForm?.(editing.form, set)}
        </div>
        <ErrorText error={saveError} />
      </Modal>
      <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
    </>
  )
}
