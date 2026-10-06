import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, BaseTable, Button, Details, Modal, Spinner, Title, T, dynamicTranslation } from '@nttdsp/react-components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type UUID } from '../api'
import { useCompanies, useMe } from '../hooks'
import { useBreadcrumbs } from '../portal'
import { CheckboxField, ErrorText, NumberField, SelectField, TextAreaField, TextField } from '../components/fields'
import { ScopeBadge } from '../components/scope'
import type { ExpandedProfileType, ProfileListType, RequestDetailType, RequestListType } from '../types'

const REQ_APPEARANCE: Record<string, string> = {
  submitted: 'warning', approved: 'success', rejected: 'danger', provisioning: 'info', completed: 'success',
  failed: 'danger', draft: 'secondary',
}

export function RequestStatusBadge({ status }: { status: string }) {
  return <Badge appearance={REQ_APPEARANCE[status] ?? 'info'}>{dynamicTranslation(`REQ_${status.toUpperCase()}`, status)}</Badge>
}

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : undefined)

/** Read-only rendering of an expanded profile / frozen request spec. */
export function SpecDetails({ spec }: { spec: ExpandedProfileType }) {
  return (
    <>
      <Details data={[
        { label: T.FIELD_ROLE, value: spec.role.name },
        { label: T.FIELD_OS, value: `${spec.operating_system.name ?? ''} ${spec.operating_system.version}` },
        { label: T.COL_COMPUTE, value: `${spec.compute.vcpu} vCPU (${spec.compute.cores_per_socket}/socket) · ${spec.compute.ram_gb} GB` },
        { label: T.FIELD_VCENTER, value: `${spec.placement.vcenter.name} (${spec.placement.vcenter.fqdn})` },
        { label: T.FIELD_CLUSTER, value: `${spec.placement.datacenter.name} / ${spec.placement.cluster.name}` },
        { label: T.FIELD_POOL, value: spec.placement.resource_pool?.name },
        { label: T.FIELD_FOLDER, value: spec.placement.folder?.path },
        { label: T.FIELD_TEMPLATE, value: spec.placement.template?.name },
        { label: T.STEP_NETWORK, value: spec.nics.map((n) => `${n.network.name}${n.network.vlan_id !== null ? ` (VLAN ${n.network.vlan_id})` : ''}`).join(' · ') },
      ]} />
      <h2 className="main-heading vp-section">{T.STEP_DISKS} — {spec.disk_total_gb} GB</h2>
      <BaseTable
        columns={[
          { accessor: 'mount_point', Header: T.FIELD_MOUNT, visible: true },
          { accessor: 'label', Header: T.FIELD_DISK_LABEL, visible: true },
          { accessor: 'size_gb', Header: T.FIELD_SIZE_GB, visible: true },
          { accessor: 'provisioning', Header: T.FIELD_PROVISIONING, visible: true },
          { accessor: 'datastore', Header: T.FIELD_DATASTORE, visible: true,
            Cell: ({ value }: { value: { name?: string } | null }) => <>{value?.name ?? T.DATASTORE_DEFAULT}</> },
        ]}
        data={spec.disks as unknown as Record<string, unknown>[]}
        noDataMessage={T.NO_DATA}
      />
      {spec.warnings.length > 0 && (
        <p className="vp-error">{T.WARN_ARCHIVED_REFS}: {spec.warnings.join(', ')}</p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// New request
// ---------------------------------------------------------------------------

export function NewRequestPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const { data: allCompanies } = useCompanies(!!me?.is_global_admin)
  useBreadcrumbs([{ name: T.MENU_REQUESTS, link: '/requests' }, { name: T.MENU_NEW_REQUEST }])

  const companies = me?.is_global_admin ? allCompanies ?? [] : me?.companies ?? []
  const [companyId, setCompanyId] = useState<UUID | null>(null)
  useEffect(() => {
    if (!companyId && companies.length === 1) setCompanyId(companies[0].id)
  }, [companies, companyId])

  const [profileId, setProfileId] = useState<UUID | null>(null)
  const [hostname, setHostname] = useState('')
  const [quantity, setQuantity] = useState<number | null>(1)
  const [justification, setJustification] = useState('')
  const [excluded, setExcluded] = useState<Set<UUID>>(new Set())
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const profiles = useQuery({
    queryKey: ['profiles', 'effective', companyId],
    queryFn: () => api.get<ProfileListType[]>('/profiles', { for_company: companyId }),
    enabled: !!companyId,
  })
  const spec = useQuery({
    queryKey: ['expanded', profileId],
    queryFn: () => api.get<ExpandedProfileType>(`/profiles/${profileId}/expanded`),
    enabled: !!profileId,
  })

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const { id } = await api.post<{ id: UUID }>('/requests', {
        company_id: companyId, vm_profile_id: profileId, hostname, quantity: quantity ?? 1, justification,
        excluded_software_ids: [...excluded],
      })
      await qc.invalidateQueries({ queryKey: ['requests'] })
      navigate(`/requests/${id}`)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{T.MENU_NEW_REQUEST}</h1>
      <Title title={T.MENU_NEW_REQUEST} subtitle={T.PAGE_NEW_REQUEST_SUB} />
      <div className="vp-toolbar">
        <SelectField label={T.FIELD_COMPANY} required value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(v) => { setCompanyId(v); setProfileId(null) }} />
      </div>
      {companies.length === 0 && <p className="vp-muted">{T.HELP_NO_COMPANIES}</p>}

      {companyId && !profileId && (
        <>
          <h2 className="main-heading">{T.PICK_PROFILE}</h2>
          <BaseTable
            columns={[
              { accessor: 'name', Header: T.COL_NAME, visible: true },
              { accessor: 'company_name', Header: T.COL_SCOPE, visible: true,
                Cell: ({ value }: { value: string | null }) => <ScopeBadge companyName={value} /> },
              { accessor: 'role_name', Header: T.COL_ROLE, visible: true },
              { accessor: 'os_name', Header: T.COL_OS, visible: true },
              { accessor: 'vcpu', Header: T.COL_COMPUTE, visible: true,
                Cell: ({ row }: { row: ProfileListType }) => <>{row.vcpu} vCPU · {row.ram_gb} GB</> },
              { accessor: 'disk_total_gb', Header: T.COL_DISKS, visible: true,
                Cell: ({ value }: { value: number }) => <>{value} GB</> },
              { accessor: 'description', Header: T.COL_DESCRIPTION, visible: true },
            ]}
            data={profiles.data ?? []}
            loading={profiles.isLoading}
            noDataMessage={T.NO_PROFILES_FOR_COMPANY}
            rowActions={[{ id: 'pick', label: T.ACTION_SELECT,
              onSelect: (_e: unknown, { row }: { row: ProfileListType }) => { setProfileId(row.id); setExcluded(new Set()) } }]}
          />
        </>
      )}

      {profileId && (
        spec.isLoading || !spec.data ? <Spinner /> : (
          <>
            <h2 className="main-heading">{spec.data.name}</h2>
            {spec.data.description && <p>{spec.data.description}</p>}
            <SpecDetails spec={spec.data} />
            <h2 className="main-heading vp-section">{T.STEP_SOFTWARE}</h2>
            <div className="vp-checklist">
              {spec.data.software.length === 0 && <p className="vp-muted">{T.NO_SOFTWARE}</p>}
              {spec.data.software.map((s) => (
                <CheckboxField key={s.id} name={`rq-sw-${s.id}`} disabled={s.is_mandatory}
                  checked={!excluded.has(s.id)}
                  label={<>{s.name} {s.version} {s.is_mandatory ? <Badge appearance="secondary">{T.FIELD_MANDATORY}</Badge> : <Badge appearance="info">{T.OPTIONAL}</Badge>}</>}
                  onChange={(on) => {
                    const next = new Set(excluded)
                    if (on) next.delete(s.id)
                    else next.add(s.id)
                    setExcluded(next)
                  }} />
              ))}
            </div>
            <h2 className="main-heading vp-section">{T.REQUEST_DETAILS}</h2>
            <div className="vp-form-2">
              <TextField label={T.FIELD_HOSTNAME} required value={hostname} onChange={setHostname}
                help={spec.data.naming_pattern ? `${T.HELP_NAMING_PATTERN_SHORT}: ${spec.data.naming_pattern}` : T.HELP_HOSTNAME} />
              <NumberField label={T.FIELD_QUANTITY} required min={1} value={quantity} onChange={setQuantity} />
            </div>
            <TextAreaField label={T.FIELD_JUSTIFICATION} value={justification} onChange={setJustification} />
            <ErrorText error={error} />
            <div className="vp-actions">
              <Button appearance="neutral" onClick={() => setProfileId(null)}>{T.ACTION_CHANGE_PROFILE}</Button>
              <Button appearance="primary" disabled={busy || !hostname.trim()} onClick={submit}>{T.ACTION_SUBMIT}</Button>
            </div>
          </>
        )
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export function RequestsPage({ view }: { view: 'mine' | 'pending' | 'all' }) {
  const { data: me } = useMe()
  const navigate = useNavigate()
  const title = { mine: T.MENU_MY_REQUESTS, pending: T.MENU_PENDING, all: T.MENU_ALL_REQUESTS }[view]
  useBreadcrumbs([{ name: T.MENU_REQUESTS, link: '/requests' }, { name: title }])
  const { data, isLoading, error } = useQuery({
    queryKey: ['requests', view],
    queryFn: () => api.get<RequestListType[]>('/requests', { view }),
  })
  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{title}</h1>
      <Title title={title}>
        {view !== 'all' && me?.is_admin && <Button appearance="neutral" onClick={() => navigate('/requests/all')}>{T.MENU_ALL_REQUESTS}</Button>}
        <Button appearance="primary" onClick={() => navigate('/requests/new')}>{T.MENU_NEW_REQUEST}</Button>
      </Title>
      <ErrorText error={error} />
      <BaseTable
        columns={[
          { accessor: 'hostname', Header: T.FIELD_HOSTNAME, visible: true,
            Cell: ({ row }: { row: RequestListType }) => <Link to={`/requests/${row.id}`}>{row.hostname}</Link> },
          { accessor: 'quantity', Header: T.FIELD_QUANTITY, visible: true, width: '80px' },
          { accessor: 'profile_name', Header: T.COL_PROFILE, visible: true },
          { accessor: 'company_name', Header: T.FIELD_COMPANY, visible: true },
          { accessor: 'status', Header: T.COL_STATUS, visible: true, Cell: ({ value }: { value: string }) => <RequestStatusBadge status={value} /> },
          { accessor: 'requested_by_name', Header: T.COL_REQUESTED_BY, visible: true },
          { accessor: 'created_at', Header: T.COL_CREATED, visible: true, Cell: ({ value }: { value: string }) => <>{fmt(value)}</> },
        ]}
        data={data ?? []}
        loading={isLoading}
        noDataMessage={T.NO_REQUESTS}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail + decision
// ---------------------------------------------------------------------------

export function RequestDetailPage() {
  const { requestId } = useParams()
  const qc = useQueryClient()
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)
  const [comment, setComment] = useState('')
  const [error, setError] = useState<unknown>(null)
  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['request', requestId],
    queryFn: () => api.get<RequestDetailType>(`/requests/${requestId}`),
  })
  useBreadcrumbs([{ name: T.MENU_REQUESTS, link: '/requests' }, { name: data?.hostname ?? '…' }])

  const decide = async () => {
    setError(null)
    try {
      await api.post(`/requests/${requestId}/${deciding}`, { comment })
      await qc.invalidateQueries({ queryKey: ['request', requestId] })
      await qc.invalidateQueries({ queryKey: ['requests'] })
      setDeciding(null)
      setComment('')
    } catch (e) {
      setError(e)
    }
  }

  if (isLoading) return <Spinner />
  if (!data) return <div className="vp-page"><ErrorText error={loadError} /></div>

  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{data.hostname}</h1>
      <Title title={`${data.hostname}${data.quantity > 1 ? ` ×${data.quantity}` : ''}`} subtitle={data.spec.name}>
        {data.can_decide && (
          <>
            <Button appearance="danger" onClick={() => setDeciding('reject')}>{T.ACTION_REJECT}</Button>
            <Button appearance="primary" onClick={() => setDeciding('approve')}>{T.ACTION_APPROVE}</Button>
          </>
        )}
      </Title>
      <Details data={[
        { label: T.COL_STATUS, value: <RequestStatusBadge status={data.status} /> },
        { label: T.FIELD_COMPANY, value: data.company_name },
        { label: T.COL_PROFILE, value: data.spec.name },
        { label: T.COL_REQUESTED_BY, value: data.requested_by_name },
        { label: T.COL_SUBMITTED, value: fmt(data.submitted_at) },
        { label: T.FIELD_JUSTIFICATION, value: data.justification || undefined },
        { label: T.COL_DECIDED_BY, value: data.decided_by_name || undefined },
        { label: T.COL_DECISION_COMMENT, value: data.status_reason || undefined },
      ]} />
      <h2 className="main-heading vp-section">{T.FROZEN_SPEC}</h2>
      <p className="vp-muted">{T.HELP_FROZEN_SPEC}</p>
      <SpecDetails spec={data.spec} />
      <h2 className="main-heading vp-section">{T.STEP_SOFTWARE}</h2>
      <BaseTable
        columns={[
          { accessor: 'install_order', Header: '#', visible: true, width: '50px' },
          { accessor: 'name', Header: T.COL_NAME, visible: true },
          { accessor: 'version', Header: T.COL_VERSION, visible: true },
          { accessor: 'install_method', Header: T.COL_INSTALL_METHOD, visible: true },
          { accessor: 'is_mandatory', Header: T.FIELD_MANDATORY, visible: true,
            Cell: ({ value }: { value: boolean }) => <>{value ? T.YES : T.NO}</> },
        ]}
        data={data.spec.software as unknown as Record<string, unknown>[]}
        noDataMessage={T.NO_SOFTWARE}
      />
      <h2 className="main-heading vp-section">{T.HISTORY}</h2>
      <BaseTable
        columns={[
          { accessor: 'created_at', Header: T.COL_WHEN, visible: true, Cell: ({ value }: { value: string }) => <>{fmt(value)}</> },
          { accessor: 'to_status', Header: T.COL_STATUS, visible: true, Cell: ({ value }: { value: string }) => <RequestStatusBadge status={value} /> },
          { accessor: 'user_name', Header: T.COL_BY, visible: true },
          { accessor: 'comment', Header: T.COL_COMMENT, visible: true },
        ]}
        data={data.events as unknown as Record<string, unknown>[]}
        noDataMessage={T.NO_DATA}
      />
      <Modal
        show={!!deciding}
        handleClose={() => setDeciding(null)}
        title={deciding === 'approve' ? T.ACTION_APPROVE : T.ACTION_REJECT}
        size="s"
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button appearance="neutral" onClick={() => setDeciding(null)}>{T.ACTION_CANCEL}</Button>
            <Button appearance={deciding === 'approve' ? 'primary' : 'danger'} onClick={decide}>
              {deciding === 'approve' ? T.ACTION_APPROVE : T.ACTION_REJECT}
            </Button>
          </div>
        }
      >
        <TextAreaField label={deciding === 'reject' ? T.FIELD_REJECT_REASON : T.FIELD_COMMENT} required={deciding === 'reject'}
          value={comment} onChange={setComment} />
        <ErrorText error={error} />
      </Modal>
    </div>
  )
}
