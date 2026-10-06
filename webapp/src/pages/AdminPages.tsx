import { useEffect, useState } from 'react'
import { Badge, BaseTable, Button, Field, Input, Modal, Title, T, dynamicTranslation } from '@nttdsp/react-components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, searchUsers, type DfUser, type UUID } from '../api'
import { useMe } from '../hooks'
import { useBreadcrumbs } from '../portal'
import { ConfirmModal, type ConfirmState } from '../components/ConfirmModal'
import { ErrorText, SelectField } from '../components/fields'
import { ScopeBadge, ScopeSelect } from '../components/scope'
import type { Row } from '../types'

interface Assignment extends Row {
  id: UUID
  user_id: UUID
  user_name: string
  user_email: string
  role: string
  company_id: UUID | null
  company_name: string | null
}

function GrantModal({ show, onClose }: { show: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const [term, setTerm] = useState('')
  const [users, setUsers] = useState<DfUser[]>([])
  const [loading, setLoading] = useState(false)
  const [user, setUser] = useState<DfUser | null>(null)
  const [role, setRole] = useState<string>('requester')
  const [company, setCompany] = useState<UUID | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      if (!term.trim()) {
        setUsers([])
        return
      }
      setLoading(true)
      searchUsers(term)
        .then((r) => live && setUsers(r))
        .catch((e) => live && setError(e))
        .finally(() => live && setLoading(false))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [term])

  const close = () => {
    setTerm('')
    setUser(null)
    setError(null)
    onClose()
  }
  const grant = async () => {
    if (!user) return
    try {
      await api.post('/role-assignments', {
        user_id: user.id,
        user_name: user.profile?.name ?? '',
        user_email: user.identity?.email ?? '',
        role,
        company_id: role === 'global_admin' ? null : company,
      })
      await qc.invalidateQueries({ queryKey: ['role-assignments'] })
      close()
    } catch (e) {
      setError(e)
    }
  }

  return (
    <Modal
      show={show}
      handleClose={close}
      title={T.ACTION_GRANT_ROLE}
      size="m"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button appearance="neutral" onClick={close}>{T.ACTION_CANCEL}</Button>
          <Button appearance="primary" disabled={!user || (role !== 'global_admin' && !company)} onClick={grant}>{T.ACTION_GRANT}</Button>
        </div>
      }
    >
      <div className="vp-form">
        {user ? (
          <div className="vp-grid-row" style={{ gridTemplateColumns: '1fr auto', alignItems: 'center' }}>
            <span><strong>{user.profile?.name}</strong> <span className="vp-muted">{user.identity?.email}</span></span>
            <Button appearance="text" onClick={() => setUser(null)}>{T.ACTION_CHANGE}</Button>
          </div>
        ) : (
          <>
            <Field label={T.FIELD_FIND_USER}>
              <Input value={term} autoFocus onChange={(e: { target: { value: string } }) => setTerm(e.target.value)} />
            </Field>
            <div style={{ height: 240, overflowY: 'auto' }}>
              <BaseTable
                columns={[
                  { accessor: 'name', Header: T.COL_NAME, visible: true },
                  { accessor: 'email', Header: T.COL_EMAIL, visible: true },
                  { accessor: 'title', Header: T.COL_JOB_TITLE, visible: true },
                ]}
                data={users.map((u) => ({ id: u.id, name: u.profile?.name ?? '', email: u.identity?.email ?? '', title: u.profile?.jobTitle ?? '', _u: u }))}
                loading={loading}
                noDataMessage={term ? T.NO_RESULTS : T.TYPE_TO_SEARCH}
                rowActions={[{ id: 'pick', label: T.ACTION_SELECT, onSelect: (_e: unknown, { row }: { row: { _u: DfUser } }) => setUser(row._u) }]}
              />
            </div>
          </>
        )}
        <SelectField label={T.FIELD_ROLE_ACCESS} required allowEmpty={false} value={role} onChange={(v) => setRole(v ?? 'requester')}
          options={[
            { value: 'requester', label: T.ROLE_REQUESTER },
            { value: 'company_admin', label: T.ROLE_COMPANY_ADMIN },
            ...(me?.is_global_admin ? [{ value: 'global_admin', label: T.ROLE_GLOBAL_ADMIN }] : []),
          ]} />
        {role !== 'global_admin' && (
          <ScopeSelect value={company} onChange={setCompany} label={T.FIELD_COMPANY} />
        )}
      </div>
      <ErrorText error={error} />
    </Modal>
  )
}

export function AccessPage() {
  const qc = useQueryClient()
  const [granting, setGranting] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  useBreadcrumbs([{ name: T.MENU_ADMIN }, { name: T.MENU_ACCESS }])
  const { data, isLoading, error } = useQuery({
    queryKey: ['role-assignments'],
    queryFn: () => api.get<Assignment[]>('/role-assignments'),
  })
  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{T.MENU_ACCESS}</h1>
      <Title title={T.MENU_ACCESS} subtitle={T.PAGE_ACCESS_SUB}>
        <Button appearance="primary" onClick={() => setGranting(true)}>{T.ACTION_GRANT_ROLE}</Button>
      </Title>
      <ErrorText error={error} />
      <BaseTable
        columns={[
          { accessor: 'user_name', Header: T.COL_NAME, visible: true },
          { accessor: 'user_email', Header: T.COL_EMAIL, visible: true },
          { accessor: 'role', Header: T.FIELD_ROLE_ACCESS, visible: true,
            Cell: ({ value }: { value: string }) => <Badge appearance={value === 'global_admin' ? 'primary' : 'info'}>{dynamicTranslation(`ROLE_${value.toUpperCase()}`, value)}</Badge> },
          { accessor: 'company_name', Header: T.FIELD_COMPANY, visible: true,
            Cell: ({ value }: { value: string | null }) => <ScopeBadge companyName={value} /> },
        ]}
        data={data ?? []}
        loading={isLoading}
        noDataMessage={T.NO_DATA}
        rowActions={[{
          id: 'revoke', label: T.ACTION_REVOKE,
          onSelect: (_e: unknown, { row }: { row: Assignment }) => setConfirm({
            title: T.ACTION_REVOKE, body: `${row.user_name || row.user_id}`, confirmLabel: T.ACTION_REVOKE, danger: true,
            action: async () => {
              await api.del(`/role-assignments/${row.id}`)
              await qc.invalidateQueries({ queryKey: ['role-assignments'] })
            },
          }),
        }]}
      />
      <GrantModal show={granting} onClose={() => setGranting(false)} />
      <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

export function AuditPage() {
  useBreadcrumbs([{ name: T.MENU_ADMIN }, { name: T.MENU_AUDIT }])
  const [entity, setEntity] = useState<string | null>(null)
  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', entity],
    queryFn: () => api.get<Row[]>('/audit-events', { entity_type: entity, limit: 300 }),
  })
  const entities = ['vm_profile', 'vm_request', 'vcenter', 'cluster', 'datastore', 'network', 'software', 'vm_role', 'vm_size',
    'operating_system', 'role_assignment']
  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{T.MENU_AUDIT}</h1>
      <Title title={T.MENU_AUDIT} subtitle={T.PAGE_AUDIT_SUB} />
      <div className="vp-toolbar">
        <SelectField label={T.COL_ENTITY} value={entity} emptyLabel={T.SCOPE_ALL} onChange={setEntity}
          options={entities.map((e) => ({ value: e, label: e }))} />
      </div>
      <ErrorText error={error} />
      <BaseTable
        columns={[
          { accessor: 'created_at', Header: T.COL_WHEN, visible: true, Cell: ({ value }: { value: string }) => <>{new Date(value).toLocaleString()}</> },
          { accessor: 'user_name', Header: T.COL_BY, visible: true,
            Cell: ({ row }: { row: Row }) => (
              <>{(row.user_name as string) || (row.user_id as string)}{row.user_impersonation ? <> <Badge appearance="warning">{T.IMPERSONATED}</Badge></> : null}</>
            ) },
          { accessor: 'action', Header: T.COL_ACTION, visible: true },
          { accessor: 'entity_type', Header: T.COL_ENTITY, visible: true },
          { accessor: 'summary', Header: T.COL_SUMMARY, visible: true },
          { accessor: 'company_name', Header: T.FIELD_COMPANY, visible: true,
            Cell: ({ value }: { value: string | null }) => <ScopeBadge companyName={value} /> },
        ]}
        data={data ?? []}
        loading={isLoading}
        noDataMessage={T.NO_DATA}
      />
    </div>
  )
}
