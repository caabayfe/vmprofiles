import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge, BaseTable, Button, Modal, Title, T, dynamicTranslation } from '@nttdsp/react-components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type UUID } from '../api'
import { canManage, useMe } from '../hooks'
import { useBreadcrumbs } from '../portal'
import { ConfirmModal, type ConfirmState } from '../components/ConfirmModal'
import { ErrorText, SelectField, TextField } from '../components/fields'
import { ScopeBadge, ScopeFilter, ScopeSelect } from '../components/scope'
import type { ProfileListType } from '../types'

const STATUS_APPEARANCE: Record<string, string> = { active: 'success', draft: 'warning', archived: 'secondary' }

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge appearance={STATUS_APPEARANCE[status] ?? 'info'}>
      {dynamicTranslation(`STATUS_${status.toUpperCase()}`, status)}
    </Badge>
  )
}

function CloneModal({ source, onClose }: { source: ProfileListType | null; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [company, setCompany] = useState<UUID | null>(null)
  const [error, setError] = useState<unknown>(null)
  const close = () => {
    setName('')
    setError(null)
    onClose()
  }
  const run = async () => {
    try {
      const { id } = await api.post<{ id: UUID }>(`/profiles/${source?.id}/clone`, {
        company_id: company,
        name: name || `${source?.name} (copy)`,
      })
      await qc.invalidateQueries({ queryKey: ['profiles'] })
      close()
      navigate(`/profiles/${id}`)
    } catch (e) {
      setError(e)
    }
  }
  return (
    <Modal
      show={!!source}
      handleClose={close}
      title={`${T.ACTION_CLONE} — ${source?.name ?? ''}`}
      size="s"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button appearance="neutral" onClick={close}>{T.ACTION_CANCEL}</Button>
          <Button appearance="primary" onClick={run}>{T.ACTION_CLONE}</Button>
        </div>
      }
    >
      <div className="vp-form">
        <p className="vp-muted">{T.HELP_CLONE}</p>
        <ScopeSelect value={company} onChange={setCompany} label={T.FIELD_TARGET_SCOPE} />
        <TextField label={T.FIELD_NAME} required value={name} placeholder={`${source?.name ?? ''} (copy)`} onChange={setName} />
      </div>
      <ErrorText error={error} />
    </Modal>
  )
}

export function ProfilesPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const [scope, setScope] = useState('all')
  const [status, setStatus] = useState<string>('')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [cloning, setCloning] = useState<ProfileListType | null>(null)
  useBreadcrumbs([{ name: T.PAGE_PROFILES }])

  const { data, isLoading, error } = useQuery({
    queryKey: ['profiles', scope, status],
    queryFn: () => api.get<ProfileListType[]>('/profiles', { scope, status: status || undefined }),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['profiles'] })
  const setProfileStatus = (row: ProfileListType, to: string) => async () => {
    await api.post(`/profiles/${row.id}/status`, { status: to })
    await refresh()
  }
  const manageable = (row: ProfileListType) => canManage(me, row.company_id)

  const columns = [
    { accessor: 'name', Header: T.COL_NAME, visible: true,
      Cell: ({ row }: { row: { original: ProfileListType } }) => (
        <Link to={`/profiles/${row.original.id}`}>{row.original.name}</Link>
      ) },
    { accessor: 'company_name', Header: T.COL_SCOPE, visible: true,
      Cell: ({ value }: { value: string | null }) => <ScopeBadge companyName={value} /> },
    { accessor: 'status', Header: T.COL_STATUS, visible: true, width: '110px',
      Cell: ({ value }: { value: string }) => <StatusBadge status={value} /> },
    { accessor: 'role_name', Header: T.COL_ROLE, visible: true },
    { accessor: 'os_name', Header: T.COL_OS, visible: true },
    { accessor: 'vcpu', Header: T.COL_COMPUTE, visible: true,
      Cell: ({ row }: { row: { original: ProfileListType } }) => <>{row.original.vcpu} vCPU · {row.original.ram_gb} GB</> },
    { accessor: 'disk_total_gb', Header: T.COL_DISKS, visible: true,
      Cell: ({ row }: { row: { original: ProfileListType } }) => <>{row.original.disk_count} · {row.original.disk_total_gb} GB</> },
    { accessor: 'cluster_name', Header: T.COL_PLACEMENT, visible: true,
      Cell: ({ row }: { row: { original: ProfileListType } }) => <>{row.original.vcenter_name} / {row.original.cluster_name}</> },
    { accessor: 'software_count', Header: T.COL_SOFTWARE, visible: true, width: '90px' },
  ]

  type A = { row: ProfileListType }
  const rowActions = [
    { id: 'edit', label: T.ACTION_EDIT, visible: ({ row }: A) => manageable(row),
      onSelect: (_e: unknown, { row }: A) => navigate(`/profiles/${row.id}`) },
    { id: 'clone', label: T.ACTION_CLONE, visible: () => !!me?.is_admin,
      onSelect: (_e: unknown, { row }: A) => setCloning(row) },
    { id: 'activate', label: T.ACTION_ACTIVATE, visible: ({ row }: A) => manageable(row) && row.status !== 'active',
      onSelect: (_e: unknown, { row }: A) => setProfileStatus(row, 'active')() },
    { id: 'archive', label: T.ACTION_ARCHIVE, visible: ({ row }: A) => manageable(row) && row.status !== 'archived',
      onSelect: (_e: unknown, { row }: A) => setConfirm({
        title: T.CONFIRM_ARCHIVE_TITLE, body: T.CONFIRM_ARCHIVE_PROFILE_BODY, confirmLabel: T.ACTION_ARCHIVE,
        action: setProfileStatus(row, 'archived'),
      }) },
    { id: 'delete', label: T.ACTION_DELETE, visible: ({ row }: A) => manageable(row),
      onSelect: (_e: unknown, { row }: A) => setConfirm({
        title: T.CONFIRM_DELETE_TITLE, body: T.CONFIRM_DELETE_PROFILE_BODY, confirmLabel: T.ACTION_DELETE, danger: true,
        action: async () => {
          await api.del(`/profiles/${row.id}`)
          await refresh()
        },
      }) },
  ]

  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{T.PAGE_PROFILES}</h1>
      <Title title={T.PAGE_PROFILES} subtitle={T.PAGE_PROFILES_SUB}>
        {me?.is_admin && <Button appearance="primary" onClick={() => navigate('/profiles/new')}>{T.ACTION_NEW_PROFILE}</Button>}
      </Title>
      <div className="vp-toolbar">
        <ScopeFilter value={scope} onChange={setScope} />
        <SelectField
          label={T.COL_STATUS}
          value={status}
          emptyLabel={T.STATUS_NOT_ARCHIVED}
          onChange={(v) => setStatus(v ?? '')}
          options={[
            { value: 'active', label: T.STATUS_ACTIVE },
            { value: 'draft', label: T.STATUS_DRAFT },
            { value: 'archived', label: T.STATUS_ARCHIVED },
            { value: 'any', label: T.STATUS_ANY },
          ]}
        />
      </div>
      <ErrorText error={error} />
      <BaseTable columns={columns} data={data ?? []} loading={isLoading} noDataMessage={T.NO_PROFILES} rowActions={rowActions} />
      <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
      <CloneModal source={cloning} onClose={() => setCloning(null)} />
    </div>
  )
}
