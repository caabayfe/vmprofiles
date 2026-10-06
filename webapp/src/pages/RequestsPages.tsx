import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, BaseTable, Button, Details, Modal, Spinner, Title, T, dynamicTranslation, hydrateTranslation } from '@nttdsp/react-components'
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
        { label: T.STEP_NETWORK, value: spec.nics.map((n) => `${n.network.name}${n.network.vlan_id !== null ? ` (VLAN ${n.network.vlan_id})` : ''}` +
            ` · ${n.network.addressing === 'static' ? `${n.network.subnet_cidr ?? ''}${n.network.gateway ? ` gw ${n.network.gateway}` : ''}` : T.ADDRESSING_DHCP}`).join(' · ') },
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

interface ExtraDiskForm {
  size_gb: number | null
  mount_point: string
  label: string
  datastore_id: UUID | null
}

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function useDebounced<V>(value: V, delay = 400): V {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}

export function CapacityWarnings({ title, warnings }: { title: string; warnings: string[] | undefined }) {
  if (!warnings) return null
  return warnings.length === 0 ? (
    <p className="vp-muted">{title}: {T.CAPACITY_OK}</p>
  ) : (
    <div className="vp-section">
      <Badge appearance="warning">{title}</Badge>
      <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </div>
  )
}

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
  const [sizeId, setSizeId] = useState<UUID | null>(null)
  const [extraDisks, setExtraDisks] = useState<ExtraDiskForm[]>([])
  const [nicNetworks, setNicNetworks] = useState<Record<number, UUID>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const profiles = useQuery({
    queryKey: ['profiles', 'effective', companyId],
    queryFn: () => api.get<ProfileListType[]>('/profiles', { for_company: companyId }),
    enabled: !!companyId,
  })
  const base = useQuery({
    queryKey: ['expanded', profileId],
    queryFn: () => api.get<ExpandedProfileType>(`/profiles/${profileId}/expanded`),
    enabled: !!profileId,
  })
  const adj = base.data?.adjustable

  const pick = (id: UUID) => {
    setProfileId(id)
    setExcluded(new Set())
    setSizeId(null)
    setExtraDisks([])
    setNicNetworks({})
  }

  // The server builds the exact spec (adjustments validated) + capacity warnings.
  const body = {
    company_id: companyId, vm_profile_id: profileId,
    hostname: HOSTNAME_RE.test(hostname) ? hostname : 'preview', quantity: quantity ?? 1, justification,
    excluded_software_ids: [...excluded],
    vm_size_id: sizeId,
    extra_disks: extraDisks.filter((x) => x.size_gb && x.mount_point.trim())
      .map((x) => ({ ...x, datastore_id: x.datastore_id || null })),
    nic_networks: Object.entries(nicNetworks).map(([order, network_id]) => ({ nic_order: Number(order), network_id })),
  }
  const debounced = useDebounced(JSON.stringify(body))
  const preview = useQuery({
    queryKey: ['request-preview', debounced],
    queryFn: () => api.post<ExpandedProfileType>('/requests/preview', JSON.parse(debounced)),
    enabled: !!profileId && !!companyId,
    retry: false,
  })

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const { id } = await api.post<{ id: UUID }>('/requests', { ...body, hostname })
      await qc.invalidateQueries({ queryKey: ['requests'] })
      navigate(`/requests/${id}`)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const spec = preview.data ?? base.data
  const setDisk = (i: number, patch: Partial<ExtraDiskForm>) =>
    setExtraDisks((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)))

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
              onSelect: (_e: unknown, { row }: { row: ProfileListType }) => pick(row.id) }]}
          />
        </>
      )}

      {profileId && (
        !base.data || !spec ? <Spinner /> : (
          <>
            <h2 className="main-heading">{base.data.name}</h2>
            {base.data.description && <p>{base.data.description}</p>}

            {adj && (adj.sizes.length > 1 || adj.max_extra_disks > 0 || adj.nic_options.length > 0) && (
              <>
                <h2 className="main-heading vp-section">{T.ADJUST_TITLE}</h2>
                <div className="vp-form">
                  {adj.sizes.length > 1 && (
                    <SelectField label={T.FIELD_SIZE} allowEmpty={false} value={sizeId ?? adj.sizes[0].id}
                      options={adj.sizes.map((z) => ({ value: z.id, label: `${z.name} — ${z.vcpu} vCPU / ${z.ram_gb} GB` }))}
                      onChange={(v) => setSizeId(v === adj.sizes[0].id ? null : v)} />
                  )}
                  {adj.nic_options.map((o) => (
                    <SelectField key={o.nic_order} label={`${T.FIELD_NETWORK} ${o.nic_order + 1}`} allowEmpty={false}
                      value={nicNetworks[o.nic_order] ?? o.networks[0].id}
                      options={o.networks.map((n) => ({ value: n.id, label:
                        `${n.name}${n.vlan_id !== null ? ` (VLAN ${n.vlan_id})` : ''} · ${n.addressing === 'static' ? n.subnet_cidr : T.ADDRESSING_DHCP}` }))}
                      onChange={(v) => setNicNetworks((m) => ({ ...m, [o.nic_order]: v ?? o.networks[0].id }))} />
                  ))}
                  {adj.max_extra_disks > 0 && (
                    <div>
                      <strong>{T.EXTRA_DISKS}</strong>
                      <p className="vp-muted">
                        {hydrateTranslation(T.EXTRA_DISKS_SUMMARY, { n: String(adj.max_extra_disks), gb: String(adj.max_extra_disk_gb) })}
                      </p>
                      {extraDisks.map((x, i) => (
                        <div key={i} className="vp-grid-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 1.4fr auto' }}>
                          <TextField label={T.FIELD_MOUNT} required value={x.mount_point} onChange={(v) => setDisk(i, { mount_point: v })} />
                          <NumberField label={T.FIELD_SIZE_GB} required min={1} value={x.size_gb} onChange={(v) => setDisk(i, { size_gb: v })} />
                          <TextField label={T.FIELD_DISK_LABEL} value={x.label} onChange={(v) => setDisk(i, { label: v })} />
                          <SelectField label={T.FIELD_DATASTORE} value={x.datastore_id} emptyLabel={T.DATASTORE_DEFAULT}
                            options={adj.datastores.map((d) => ({ value: d.id, label:
                              `${d.name}${d.free_gb !== null ? ` · ${d.free_gb} GB ${T.FREE}` : ''}` }))}
                            onChange={(v) => setDisk(i, { datastore_id: v })} />
                          <Button appearance="text" onClick={() => setExtraDisks((l) => l.filter((_, j) => j !== i))}>{T.ACTION_REMOVE}</Button>
                        </div>
                      ))}
                      {extraDisks.length < adj.max_extra_disks && (
                        <Button appearance="neutral" onClick={() => setExtraDisks((l) => [...l, {
                          size_gb: Math.min(100, adj.max_extra_disk_gb), mount_point: '', label: '', datastore_id: null }])}>
                          {T.ACTION_ADD_DISK}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            <h2 className="main-heading vp-section">{T.REQUEST_SUMMARY}</h2>
            <SpecDetails spec={spec} />
            <h2 className="main-heading vp-section">{T.STEP_SOFTWARE}</h2>
            <div className="vp-checklist">
              {base.data.software.length === 0 && <p className="vp-muted">{T.NO_SOFTWARE}</p>}
              {base.data.software.map((sw) => (
                <CheckboxField key={sw.id} name={`rq-sw-${sw.id}`} disabled={sw.is_mandatory}
                  checked={!excluded.has(sw.id)}
                  label={<>{sw.name} {sw.version} {sw.is_mandatory ? <Badge appearance="secondary">{T.FIELD_MANDATORY}</Badge> : <Badge appearance="info">{T.OPTIONAL}</Badge>}</>}
                  onChange={(on) => {
                    const next = new Set(excluded)
                    if (on) next.delete(sw.id)
                    else next.add(sw.id)
                    setExcluded(next)
                  }} />
              ))}
            </div>
            <h2 className="main-heading vp-section">{T.REQUEST_DETAILS}</h2>
            <div className="vp-form-2">
              <TextField label={T.FIELD_HOSTNAME} required value={hostname} onChange={setHostname}
                help={base.data.naming_pattern ? `${T.HELP_NAMING_PATTERN_SHORT}: ${base.data.naming_pattern}` : T.HELP_HOSTNAME} />
              <NumberField label={T.FIELD_QUANTITY} required min={1} value={quantity} onChange={setQuantity} />
            </div>
            {spec.request && (quantity ?? 1) > 1 && HOSTNAME_RE.test(hostname) && (
              <p className="vp-muted">{T.HOSTNAMES}: {spec.request.hostnames.join(', ')}</p>
            )}
            <TextAreaField label={T.FIELD_JUSTIFICATION} value={justification} onChange={setJustification} />
            {preview.isFetching && <p className="vp-muted">{T.CHECKING}</p>}
            {preview.error && <ErrorText error={preview.error} />}
            <CapacityWarnings title={T.CAPACITY_CHECK} warnings={preview.data?.capacity_check?.warnings} />
            <ErrorText error={error} />
            <div className="vp-actions">
              <Button appearance="neutral" onClick={() => setProfileId(null)}>{T.ACTION_CHANGE_PROFILE}</Button>
              <Button appearance="primary" disabled={busy || !HOSTNAME_RE.test(hostname) || !!preview.error} onClick={submit}>
                {T.ACTION_SUBMIT}
              </Button>
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
      {data.spec.adjustments && Object.keys(data.spec.adjustments).length > 0 && (
        <>
          <h2 className="main-heading vp-section">{T.ADJUSTMENTS_MADE}</h2>
          <Details data={[
            { label: T.FIELD_SIZE, value: data.spec.adjustments.size
              ? `${data.spec.adjustments.size.from} → ${data.spec.adjustments.size.to}` : undefined },
            { label: T.EXTRA_DISKS, value: data.spec.adjustments.extra_disks
              ?.map((x) => `${x.mount_point} ${x.size_gb} GB`).join(' · ') },
            { label: T.STEP_NETWORK, value: data.spec.adjustments.networks
              ?.map((x) => `NIC ${x.nic_order + 1}: ${x.from} → ${x.to}`).join(' · ') },
            { label: T.EXCLUDED_SOFTWARE, value: data.spec.adjustments.excluded_software?.join(', ') },
          ]} />
        </>
      )}
      <CapacityWarnings title={T.CAPACITY_AT_SUBMIT} warnings={data.spec.capacity_check?.warnings} />
      <CapacityWarnings title={T.CAPACITY_NOW} warnings={data.capacity_now} />
      {data.spec.instances && (
        <>
          <h2 className="main-heading vp-section">{T.VMS_AND_IPS}</h2>
          <BaseTable
            columns={[
              { accessor: 'hostname', Header: T.FIELD_HOSTNAME, visible: true },
              { accessor: 'network_name', Header: T.FIELD_NETWORK, visible: true },
              { accessor: 'ip', Header: T.COL_IP, visible: true,
                Cell: ({ row }: { row: Record<string, unknown> }) => row.addressing === 'static'
                  ? <>{`${row.ip as string}/${row.prefix_length as number}`}</> : <Badge appearance="secondary">{T.ADDRESSING_DHCP}</Badge> },
              { accessor: 'gateway', Header: T.FIELD_GATEWAY, visible: true },
              { accessor: 'dns', Header: T.FIELD_DNS_SERVERS, visible: true },
            ]}
            data={data.spec.instances.flatMap((inst) => inst.nics.map((n) => ({
              hostname: inst.hostname, network_name: n.network_name, addressing: n.addressing, ip: n.ip,
              prefix_length: n.prefix_length, gateway: n.gateway ?? '', dns: n.dns_servers.join(', '),
            })))}
            noDataMessage={T.NO_DATA}
          />
        </>
      )}
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
