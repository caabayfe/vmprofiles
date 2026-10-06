import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge, BaseTable, Button, Details, Modal, Spinner, Tabs, Title, T } from '@nttdsp/react-components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type UUID } from '../api'
import { canManage, useMe } from '../hooks'
import { useBreadcrumbs } from '../portal'
import { CheckboxField, ErrorText, TextField } from '../components/fields'
import { ResourceTable, useResourceList, type ResourceConfig } from '../components/ResourceTable'
import { ScopeBadge, ScopeFilter } from '../components/scope'
import type { OperatingSystemType, Row } from '../types'

const vcentersConfig = (): ResourceConfig => ({
  path: '/vcenters',
  queryKey: 'vcenters',
  singular: T.SINGULAR_VCENTER,
  scoped: true,
  columns: [
    {
      accessor: 'name', Header: T.COL_NAME,
      Cell: ({ row }: { row: Row }) => <Link to={`/infrastructure/${row.id as string}`}>{row.name as string}</Link>,
    },
    { accessor: 'fqdn', Header: T.COL_FQDN },
    { accessor: 'description', Header: T.COL_DESCRIPTION },
  ],
  fields: [
    { key: 'company_id', label: T.FIELD_VCENTER_SCOPE, type: 'scope', immutable: true },
    { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
    { key: 'fqdn', label: T.FIELD_FQDN, type: 'text', required: true },
    { key: 'credential_secret_name', label: T.FIELD_SECRET_NAME, type: 'text', help: T.HELP_SECRET_NAME },
    { key: 'description', label: T.FIELD_DESCRIPTION, type: 'textarea' },
  ],
})

export function VcentersPage() {
  const [scope, setScope] = useState('all')
  const [archived, setArchived] = useState(false)
  const config = useMemo(vcentersConfig, [])
  useBreadcrumbs([{ name: T.MENU_INFRA }])
  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{T.PAGE_VCENTERS}</h1>
      <Title title={T.PAGE_VCENTERS} subtitle={T.PAGE_VCENTERS_SUB} />
      <div className="vp-toolbar">
        <ScopeFilter value={scope} onChange={setScope} />
        <CheckboxField name="show-archived" label={T.SHOW_ARCHIVED} checked={archived} onChange={setArchived} />
      </div>
      <ResourceTable config={config} params={{ scope }} showArchived={archived} addLabel={T.ACTION_ADD_VCENTER} />
    </div>
  )
}

const opts = (rows: Row[] | undefined, label = (r: Row) => r.name as string) =>
  (rows ?? []).filter((r) => r.is_active !== false).map((r) => ({ value: r.id as string, label: label(r) }))

/** Attach a datastore / network to clusters of the same vCenter. */
function AttachModal({
  row, kind, clusters, onClose,
}: { row: Row | null; kind: 'datastores' | 'networks'; clusters: Row[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<UUID> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const current = selected ?? new Set((row?.cluster_ids as UUID[] | undefined) ?? [])
  const close = () => {
    setSelected(null)
    setError(null)
    onClose()
  }
  const save = async () => {
    try {
      await api.put(`/${kind}/${row?.id as string}/clusters`, { cluster_ids: [...current] })
      await qc.invalidateQueries({ queryKey: [kind] })
      await qc.invalidateQueries({ queryKey: ['lookups'] })
      close()
    } catch (e) {
      setError(e)
    }
  }
  return (
    <Modal
      show={!!row}
      handleClose={close}
      title={`${T.ACTION_ATTACH_CLUSTERS} — ${(row?.name as string) ?? ''}`}
      size="s"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button appearance="neutral" onClick={close}>{T.ACTION_CANCEL}</Button>
          <Button appearance="primary" onClick={save}>{T.ACTION_SAVE}</Button>
        </div>
      }
    >
      <p className="vp-muted">{T.HELP_ATTACH_CLUSTERS}</p>
      <div className="vp-checklist">
        {clusters.map((c) => (
          <CheckboxField
            key={c.id as string}
            name={`cl-${c.id as string}`}
            label={`${c.datacenter_name as string} / ${c.name as string}`}
            checked={current.has(c.id as UUID)}
            onChange={(on) => {
              const next = new Set(current)
              if (on) next.add(c.id as UUID)
              else next.delete(c.id as UUID)
              setSelected(next)
            }}
          />
        ))}
      </div>
      <ErrorText error={error} />
    </Modal>
  )
}

interface SyncRow extends Row {
  id: UUID
  source: string
  dry_run: boolean
  change_count: number
  warnings: string[]
  summary: Record<string, Record<string, number>>
  user_name: string
  created_at: string
}

/** Compact "clusters +2 ~1 −1" style summary of one sync run. */
function syncSummary(summary: SyncRow['summary']): string {
  const sign: Record<string, string> = { created: '+', restored: '↺', updated: '~', archived: '−', attached: '+', detached: '−' }
  return Object.entries(summary)
    .map(([entity, counts]) => {
      const parts = Object.entries(counts).filter(([k]) => sign[k]).map(([k, n]) => `${sign[k]}${n}`)
      return parts.length ? `${entity} ${parts.join(' ')}` : ''
    })
    .filter(Boolean)
    .join(' · ')
}

/** Runs of the external inventory feed for this vCenter. */
function SyncHistory({ vcenterId }: { vcenterId: UUID }) {
  const [detail, setDetail] = useState<SyncRow | null>(null)
  const { data, isLoading, error } = useQuery({
    queryKey: ['inventory-syncs', vcenterId],
    queryFn: () => api.get<SyncRow[]>('/inventory/syncs', { vcenter_id: vcenterId }),
  })
  return (
    <>
      <p className="vp-muted">{T.HELP_SYNC_HISTORY}</p>
      <ErrorText error={error} />
      <BaseTable
        columns={[
          { accessor: 'created_at', Header: T.COL_WHEN, visible: true,
            Cell: ({ value }: { value: string }) => <>{new Date(value).toLocaleString()}</> },
          { accessor: 'source', Header: T.COL_SOURCE, visible: true },
          { accessor: 'user_name', Header: T.COL_BY, visible: true },
          { accessor: 'dry_run', Header: T.COL_MODE, visible: true,
            Cell: ({ value }: { value: boolean }) => value
              ? <Badge appearance="secondary">{T.SYNC_DRY_RUN}</Badge> : <Badge appearance="success">{T.SYNC_APPLIED}</Badge> },
          { accessor: 'change_count', Header: T.COL_CHANGES, visible: true,
            Cell: ({ row }: { row: SyncRow }) => <>{row.change_count ? syncSummary(row.summary) : T.SYNC_NO_CHANGES}</> },
          { accessor: 'warnings', Header: T.COL_WARNINGS, visible: true, width: '100px',
            Cell: ({ value }: { value: string[] }) => value.length
              ? <Badge appearance="warning">{value.length}</Badge> : <>0</> },
        ]}
        data={data ?? []}
        loading={isLoading}
        noDataMessage={T.NO_SYNCS}
        rowActions={[{ id: 'details', label: T.ACTION_DETAILS, onSelect: (_e: unknown, { row }: { row: SyncRow }) => setDetail(row) }]}
      />
      <Modal show={!!detail} handleClose={() => setDetail(null)} title={T.SYNC_DETAILS} size="m">
        {detail && (
          <>
            <Details data={[
              { label: T.COL_WHEN, value: new Date(detail.created_at).toLocaleString() },
              { label: T.COL_SOURCE, value: detail.source || undefined },
              { label: T.COL_BY, value: detail.user_name },
              { label: T.COL_MODE, value: detail.dry_run ? T.SYNC_DRY_RUN : T.SYNC_APPLIED },
              ...Object.entries(detail.summary).map(([entity, counts]) => ({
                label: entity,
                value: Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(', '),
              })),
            ]} />
            {detail.warnings.length > 0 && (
              <>
                <h2 className="main-heading vp-section">{T.COL_WARNINGS}</h2>
                <ul>{detail.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </>
            )}
          </>
        )}
      </Modal>
    </>
  )
}

/** "used / total unit (free)" — free is derived, nothing is queried live. */
const usage = (used: unknown, total: unknown, unit: string) => {
  if (total === null || total === undefined) return '—'
  if (used === null || used === undefined) return `? / ${total as number} ${unit}`
  return `${used as number} / ${total as number} ${unit} (${(total as number) - (used as number)} ${T.FREE})`
}
const when = (value: unknown) => (value ? new Date(value as string).toLocaleDateString() : '—')

interface AllocationRow extends Row {
  id: UUID
  ip: string
  kind: 'request' | 'reserved'
  hostname: string
  note: string
  vm_request_id: UUID | null
}

/** Allocations of a network's IP pool; reserve externally-used IPs, release. */
function IpAddressesModal({ network, onClose }: { network: Row | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [ip, setIp] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<unknown>(null)
  const id = network?.id as UUID | undefined
  const { data, isLoading } = useQuery({
    queryKey: ['ip-allocations', id],
    queryFn: () => api.get<AllocationRow[]>(`/networks/${id}/ip-allocations`),
    enabled: !!id,
  })
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['ip-allocations', id] })
    await qc.invalidateQueries({ queryKey: ['networks'] })
    await qc.invalidateQueries({ queryKey: ['lookups'] })
  }
  const reserve = async () => {
    setError(null)
    try {
      await api.post(`/networks/${id}/ip-allocations`, { ip: ip.trim(), note })
      setIp('')
      setNote('')
      await refresh()
    } catch (e) {
      setError(e)
    }
  }
  const release = async (row: AllocationRow) => {
    setError(null)
    try {
      await api.del(`/ip-allocations/${row.id}`)
      await refresh()
    } catch (e) {
      setError(e)
    }
  }
  return (
    <Modal show={!!network} handleClose={onClose} size="l"
      title={`${T.ACTION_IP_ADDRESSES} — ${(network?.name as string) ?? ''}`}>
      {network && (
        <Details data={[
          { label: T.FIELD_SUBNET, value: network.subnet_cidr as string },
          { label: T.FIELD_GATEWAY, value: (network.gateway as string) || undefined },
          { label: T.COL_IP_POOL, value: network.ip_pool_start
            ? `${network.ip_pool_start as string} – ${network.ip_pool_end as string}` : T.ADDRESSING_DHCP },
        ]} />
      )}
      <div className="vp-grid-row vp-section" style={{ gridTemplateColumns: '1fr 2fr auto' }}>
        <TextField label={T.FIELD_RESERVE_IP} value={ip} onChange={setIp} />
        <TextField label={T.FIELD_NOTE} value={note} onChange={setNote} />
        <Button appearance="neutral" disabled={!ip.trim()} onClick={reserve}>{T.ACTION_RESERVE}</Button>
      </div>
      <ErrorText error={error} />
      <div style={{ height: 320, overflowY: 'auto', marginTop: 12 }}>
        <BaseTable
          columns={[
            { accessor: 'ip', Header: T.COL_IP, visible: true },
            { accessor: 'kind', Header: T.COL_TYPE, visible: true,
              Cell: ({ value }: { value: string }) => value === 'reserved'
                ? <Badge appearance="secondary">{T.IP_RESERVED}</Badge> : <Badge appearance="info">{T.IP_ASSIGNED}</Badge> },
            { accessor: 'hostname', Header: T.FIELD_HOSTNAME, visible: true,
              Cell: ({ row }: { row: AllocationRow }) => row.vm_request_id
                ? <Link to={`/requests/${row.vm_request_id}`} onClick={onClose}>{row.hostname}</Link> : <>{row.note}</> },
          ]}
          data={data ?? []}
          loading={isLoading}
          noDataMessage={T.NO_ALLOCATIONS}
          rowActions={[{ id: 'release', label: T.ACTION_RELEASE,
            onSelect: (_e: unknown, { row }: { row: AllocationRow }) => release(row) }]}
        />
      </div>
    </Modal>
  )
}

export function VcenterDetailPage() {
  const { vcenterId } = useParams()
  const { data: me } = useMe()
  const { data: vcenters, isLoading } = useQuery({
    queryKey: ['vcenters', { detail: vcenterId }, true],
    queryFn: () => api.get<Row[]>('/vcenters', { include_archived: true }),
  })
  const vc = vcenters?.find((v) => v.id === vcenterId)
  useBreadcrumbs([{ name: T.MENU_INFRA, link: '/infrastructure' }, { name: (vc?.name as string) ?? '…' }])
  const owner = (vc?.company_id as UUID | null | undefined) ?? null
  const fixed = { vcenter_id: vcenterId }
  const params = { vcenter_id: vcenterId }

  const [attach, setAttach] = useState<{ row: Row; kind: 'datastores' | 'networks' } | null>(null)
  const [ipNetwork, setIpNetwork] = useState<Row | null>(null)

  const dcConfig: ResourceConfig = useMemo(() => ({
    path: '/datacenters', queryKey: 'datacenters', singular: T.SINGULAR_DATACENTER,
    columns: [{ accessor: 'name', Header: T.COL_NAME }],
    fields: [{ key: 'name', label: T.FIELD_NAME, type: 'text', required: true }],
  }), [])
  const { data: dcs } = useResourceList(dcConfig, params)

  const clusterConfig: ResourceConfig = useMemo(() => ({
    path: '/clusters', queryKey: 'clusters', singular: T.SINGULAR_CLUSTER,
    columns: [
      { accessor: 'name', Header: T.COL_NAME },
      { accessor: 'datacenter_name', Header: T.COL_DATACENTER },
      { accessor: 'cpu_used_mhz', Header: T.COL_CPU_USAGE,
        Cell: ({ row }: { row: Row }) => <>{usage(row.cpu_used_mhz, row.cpu_total_mhz, 'MHz')}</> },
      { accessor: 'memory_used_gb', Header: T.COL_MEMORY_USAGE,
        Cell: ({ row }: { row: Row }) => <>{usage(row.memory_used_gb, row.memory_total_gb, 'GB')}</> },
      { accessor: 'capacity_updated_at', Header: T.COL_CAPACITY_UPDATED, Cell: ({ value }: { value: unknown }) => <>{when(value)}</> },
    ],
    fields: [
      { key: 'datacenter_id', label: T.FIELD_DATACENTER, type: 'select', required: true, immutable: true, options: opts(dcs) },
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
      { key: 'cpu_total_mhz', label: T.FIELD_CPU_TOTAL, type: 'number', help: T.HELP_CAPACITY_FEED },
      { key: 'cpu_used_mhz', label: T.FIELD_CPU_USED, type: 'number' },
      { key: 'memory_total_gb', label: T.FIELD_MEMORY_TOTAL, type: 'number' },
      { key: 'memory_used_gb', label: T.FIELD_MEMORY_USED, type: 'number' },
    ],
  }), [dcs])
  const { data: clusters } = useResourceList(clusterConfig, params)
  const clusterName = (ids: UUID[]) =>
    ids.map((id) => clusters?.find((c) => c.id === id)?.name as string | undefined).filter(Boolean).join(', ')

  const { data: oses } = useQuery({
    queryKey: ['operating-systems', {}, false],
    queryFn: () => api.get<OperatingSystemType[]>('/operating-systems'),
  })

  const poolConfig: ResourceConfig = useMemo(() => ({
    path: '/resource-pools', queryKey: 'resource-pools', singular: T.SINGULAR_POOL,
    columns: [
      { accessor: 'name', Header: T.COL_NAME },
      { accessor: 'cluster_name', Header: T.COL_CLUSTER },
      { accessor: 'path', Header: T.COL_PATH },
      { accessor: 'memory_used_gb', Header: T.COL_MEMORY_USAGE,
        Cell: ({ row }: { row: Row }) => <>{row.memory_limit_gb ? usage(row.memory_used_gb, row.memory_limit_gb, 'GB') : T.UNLIMITED}</> },
      { accessor: 'capacity_updated_at', Header: T.COL_CAPACITY_UPDATED, Cell: ({ value }: { value: unknown }) => <>{when(value)}</> },
    ],
    fields: [
      { key: 'cluster_id', label: T.FIELD_CLUSTER, type: 'select', required: true, immutable: true, options: opts(clusters) },
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
      { key: 'path', label: T.FIELD_PATH, type: 'text' },
      { key: 'memory_limit_gb', label: T.FIELD_MEMORY_LIMIT, type: 'number', help: T.HELP_POOL_LIMIT },
      { key: 'memory_used_gb', label: T.FIELD_MEMORY_USED, type: 'number' },
      { key: 'cpu_limit_mhz', label: T.FIELD_CPU_LIMIT, type: 'number' },
      { key: 'cpu_used_mhz', label: T.FIELD_CPU_USED, type: 'number' },
    ],
  }), [clusters])

  const clustersColumn = {
    accessor: 'cluster_ids', Header: T.COL_CLUSTERS,
    Cell: ({ value }: { value: unknown }) => {
      const ids = (value as UUID[]) ?? []
      return ids.length ? <>{clusterName(ids)}</> : <Badge appearance="warning">{T.NOT_ATTACHED}</Badge>
    },
  }

  const dsConfig: ResourceConfig = useMemo(() => ({
    path: '/datastores', queryKey: 'datastores', singular: T.SINGULAR_DATASTORE,
    columns: [
      { accessor: 'name', Header: T.COL_NAME },
      { accessor: 'type', Header: T.COL_TYPE },
      { accessor: 'used_gb', Header: T.COL_STORAGE_USAGE,
        Cell: ({ row }: { row: Row }) => <>{usage(row.used_gb, row.capacity_gb, 'GB')}</> },
      { accessor: 'capacity_updated_at', Header: T.COL_CAPACITY_UPDATED, Cell: ({ value }: { value: unknown }) => <>{when(value)}</> },
      clustersColumn,
    ],
    fields: [
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
      { key: 'type', label: T.FIELD_TYPE, type: 'select', required: true,
        options: ['vmfs', 'nfs', 'vsan', 'vvol'].map((v) => ({ value: v, label: v.toUpperCase() })) },
      { key: 'capacity_gb', label: T.FIELD_CAPACITY_GB, type: 'number', help: T.HELP_CAPACITY_FEED },
      { key: 'used_gb', label: T.FIELD_USED_GB, type: 'number' },
    ],
    defaults: { type: 'vmfs' },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [clusters])

  const netConfig: ResourceConfig = useMemo(() => ({
    path: '/networks', queryKey: 'networks', singular: T.SINGULAR_NETWORK,
    columns: [
      { accessor: 'name', Header: T.COL_NAME },
      { accessor: 'type', Header: T.COL_TYPE },
      { accessor: 'vlan_id', Header: T.COL_VLAN },
      { accessor: 'subnet_cidr', Header: T.COL_SUBNET, Cell: ({ value }: { value: unknown }) => <>{(value as string) || '—'}</> },
      { accessor: 'ip_pool_size', Header: T.COL_IP_POOL,
        Cell: ({ row }: { row: Row }) => row.ip_pool_size
          ? <>{`${row.ip_allocated as number} / ${row.ip_pool_size as number} ${T.USED}`}</>
          : <Badge appearance="secondary">{T.ADDRESSING_DHCP}</Badge> },
      clustersColumn,
    ],
    fields: [
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
      { key: 'type', label: T.FIELD_TYPE, type: 'select', required: true,
        options: [{ value: 'dvportgroup', label: 'Distributed port group' }, { value: 'standard', label: 'Standard' },
          { value: 'nsx', label: 'NSX segment' }] },
      { key: 'vlan_id', label: T.FIELD_VLAN, type: 'number' },
      { key: 'subnet_cidr', label: T.FIELD_SUBNET, type: 'text', help: T.HELP_SUBNET },
      { key: 'gateway', label: T.FIELD_GATEWAY, type: 'text' },
      { key: 'dns_servers', label: T.FIELD_DNS_SERVERS, type: 'text', help: T.HELP_DNS_SERVERS },
      { key: 'dns_domain', label: T.FIELD_DNS_DOMAIN, type: 'text' },
      { key: 'ip_pool_start', label: T.FIELD_POOL_START, type: 'text', help: T.HELP_IP_POOL },
      { key: 'ip_pool_end', label: T.FIELD_POOL_END, type: 'text' },
    ],
    defaults: { type: 'dvportgroup', dns_servers: [] },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [clusters])

  const folderConfig: ResourceConfig = useMemo(() => ({
    path: '/folders', queryKey: 'folders', singular: T.SINGULAR_FOLDER,
    columns: [{ accessor: 'path', Header: T.COL_PATH }, { accessor: 'datacenter_name', Header: T.COL_DATACENTER }],
    fields: [
      { key: 'datacenter_id', label: T.FIELD_DATACENTER, type: 'select', required: true, immutable: true, options: opts(dcs) },
      { key: 'path', label: T.FIELD_FOLDER_PATH, type: 'text', required: true, help: T.HELP_FOLDER_PATH },
    ],
  }), [dcs])

  const tplConfig: ResourceConfig = useMemo(() => ({
    path: '/templates', queryKey: 'templates', singular: T.SINGULAR_TEMPLATE,
    columns: [
      { accessor: 'name', Header: T.COL_NAME },
      { accessor: 'operating_system_name', Header: T.COL_OS },
      { accessor: 'content_library', Header: T.COL_CONTENT_LIBRARY },
      { accessor: 'os_disk_gb', Header: T.COL_OS_DISK_GB },
    ],
    fields: [
      { key: 'operating_system_id', label: T.FIELD_OS, type: 'select', required: true,
        options: (oses ?? []).map((o) => ({ value: o.id, label: `${o.name} ${o.version}` })) },
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
      { key: 'content_library', label: T.FIELD_CONTENT_LIBRARY, type: 'text' },
      { key: 'os_disk_gb', label: T.FIELD_OS_DISK_GB, type: 'number' },
    ],
  }), [oses])

  if (isLoading) return <Spinner />
  if (!vc) {
    return (
      <div className="grid-container--fluid vp-page">
        <Title title={T.NOT_FOUND} />
        <Link to="/infrastructure">{T.MENU_INFRA}</Link>
      </div>
    )
  }

  const attachAction = (kind: 'datastores' | 'networks') => [{
    id: 'attach', label: T.ACTION_ATTACH_CLUSTERS, onSelect: (row: Row) => setAttach({ row, kind }),
  }]
  const networkActions = [...attachAction('networks'), {
    id: 'ips', label: T.ACTION_IP_ADDRESSES, visible: (row: Row) => !!row.subnet_cidr,
    onSelect: (row: Row) => setIpNetwork(row),
  }]
  const editable = canManage(me, owner)

  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{vc.name as string}</h1>
      <Title title={vc.name as string} subtitle={vc.fqdn as string} />
      <Details data={[
        { label: T.FIELD_SCOPE, value: <ScopeBadge companyName={vc.owner_company_name as string | null} /> },
        { label: T.FIELD_FQDN, value: vc.fqdn as string },
        { label: T.FIELD_SECRET_NAME, value: (vc.credential_secret_name as string) || undefined },
        { label: T.FIELD_DESCRIPTION, value: (vc.description as string) || undefined },
        { label: T.COL_STATUS, value: vc.is_active ? T.STATUS_ACTIVE : T.STATUS_ARCHIVED },
      ]} />
      {!editable && <p className="vp-muted">{T.READ_ONLY_HINT}</p>}
      <div className="vp-section">
        <Tabs tabs={[
          { id: 'clusters', label: T.TAB_CLUSTERS, content: (
            <>
              <h2 className="main-heading">{T.TAB_DATACENTERS}</h2>
              <ResourceTable config={dcConfig} params={params} fixed={fixed} ownerCompanyId={owner} />
              <h2 className="main-heading vp-section">{T.TAB_CLUSTERS}</h2>
              <ResourceTable config={clusterConfig} params={params} ownerCompanyId={owner} />
            </>
          ) },
          { id: 'pools', label: T.TAB_POOLS, content: (
            <ResourceTable config={poolConfig} params={params} ownerCompanyId={owner}
              key={`pools-${(clusters ?? []).length}`} />
          ) },
          { id: 'datastores', label: T.TAB_DATASTORES, content: (
            <ResourceTable config={dsConfig} params={params} fixed={fixed} ownerCompanyId={owner}
              extraActions={attachAction('datastores')} />
          ) },
          { id: 'networks', label: T.TAB_NETWORKS, content: (
            <ResourceTable config={netConfig} params={params} fixed={fixed} ownerCompanyId={owner}
              extraActions={networkActions} />
          ) },
          { id: 'folders', label: T.TAB_FOLDERS, content: (
            <ResourceTable config={folderConfig} params={params} ownerCompanyId={owner} />
          ) },
          { id: 'templates', label: T.TAB_TEMPLATES, content: (
            <ResourceTable config={tplConfig} params={params} fixed={fixed} ownerCompanyId={owner} />
          ) },
          { id: 'syncs', label: T.TAB_SYNCS, content: <SyncHistory vcenterId={vc.id as UUID} /> },
        ]} />
      </div>
      <AttachModal
        row={attach?.row ?? null}
        kind={attach?.kind ?? 'datastores'}
        clusters={clusters ?? []}
        onClose={() => setAttach(null)}
      />
      <IpAddressesModal network={ipNetwork} onClose={() => setIpNetwork(null)} />
    </div>
  )
}
