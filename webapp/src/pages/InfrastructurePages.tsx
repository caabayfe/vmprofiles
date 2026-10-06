import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge, Button, Details, Modal, Spinner, Tabs, Title, T } from '@nttdsp/react-components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type UUID } from '../api'
import { canManage, useMe } from '../hooks'
import { useBreadcrumbs } from '../portal'
import { CheckboxField, ErrorText } from '../components/fields'
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
      Cell: ({ row }) => <Link to={`/infrastructure/${row.original.id as string}`}>{row.original.name as string}</Link>,
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

  const dcConfig: ResourceConfig = useMemo(() => ({
    path: '/datacenters', queryKey: 'datacenters', singular: T.SINGULAR_DATACENTER,
    columns: [{ accessor: 'name', Header: T.COL_NAME }],
    fields: [{ key: 'name', label: T.FIELD_NAME, type: 'text', required: true }],
  }), [])
  const { data: dcs } = useResourceList(dcConfig, params)

  const clusterConfig: ResourceConfig = useMemo(() => ({
    path: '/clusters', queryKey: 'clusters', singular: T.SINGULAR_CLUSTER,
    columns: [{ accessor: 'name', Header: T.COL_NAME }, { accessor: 'datacenter_name', Header: T.COL_DATACENTER }],
    fields: [
      { key: 'datacenter_id', label: T.FIELD_DATACENTER, type: 'select', required: true, immutable: true, options: opts(dcs) },
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
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
    ],
    fields: [
      { key: 'cluster_id', label: T.FIELD_CLUSTER, type: 'select', required: true, immutable: true, options: opts(clusters) },
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
      { key: 'path', label: T.FIELD_PATH, type: 'text' },
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
      { accessor: 'capacity_gb', Header: T.COL_CAPACITY_GB },
      clustersColumn,
    ],
    fields: [
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
      { key: 'type', label: T.FIELD_TYPE, type: 'select', required: true,
        options: ['vmfs', 'nfs', 'vsan', 'vvol'].map((v) => ({ value: v, label: v.toUpperCase() })) },
      { key: 'capacity_gb', label: T.FIELD_CAPACITY_GB, type: 'number' },
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
      clustersColumn,
    ],
    fields: [
      { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
      { key: 'type', label: T.FIELD_TYPE, type: 'select', required: true,
        options: [{ value: 'dvportgroup', label: 'Distributed port group' }, { value: 'standard', label: 'Standard' },
          { value: 'nsx', label: 'NSX segment' }] },
      { key: 'vlan_id', label: T.FIELD_VLAN, type: 'number' },
    ],
    defaults: { type: 'dvportgroup' },
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
              extraActions={attachAction('networks')} />
          ) },
          { id: 'folders', label: T.TAB_FOLDERS, content: (
            <ResourceTable config={folderConfig} params={params} ownerCompanyId={owner} />
          ) },
          { id: 'templates', label: T.TAB_TEMPLATES, content: (
            <ResourceTable config={tplConfig} params={params} fixed={fixed} ownerCompanyId={owner} />
          ) },
        ]} />
      </div>
      <AttachModal
        row={attach?.row ?? null}
        kind={attach?.kind ?? 'datastores'}
        clusters={clusters ?? []}
        onClose={() => setAttach(null)}
      />
    </div>
  )
}
