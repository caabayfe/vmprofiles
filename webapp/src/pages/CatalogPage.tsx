import { useMemo, useState } from 'react'
import { Title, T } from '@nttdsp/react-components'
import { useQuery } from '@tanstack/react-query'
import { api, type UUID } from '../api'
import { useBreadcrumbs } from '../portal'
import { CheckboxField } from '../components/fields'
import { ResourceTable, type ResourceConfig } from '../components/ResourceTable'
import { ScopeFilter } from '../components/scope'
import type { OperatingSystemType, Row } from '../types'

const osLabel = (o: { name: string; version: string }) => `${o.name} ${o.version}`.trim()

export const osConfig = (): ResourceConfig => ({
  path: '/operating-systems',
  queryKey: 'operating-systems',
  singular: T.SINGULAR_OS,
  columns: [
    { accessor: 'name', Header: T.COL_NAME },
    { accessor: 'version', Header: T.COL_VERSION },
    { accessor: 'family', Header: T.COL_FAMILY },
    { accessor: 'vmware_guest_id', Header: T.COL_GUEST_ID },
  ],
  fields: [
    { key: 'family', label: T.FIELD_FAMILY, type: 'select', required: true,
      options: [{ value: 'windows', label: 'Windows' }, { value: 'linux', label: 'Linux' }] },
    { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
    { key: 'version', label: T.FIELD_VERSION, type: 'text' },
    { key: 'vmware_guest_id', label: T.FIELD_GUEST_ID, type: 'text', help: T.HELP_GUEST_ID },
  ],
  defaults: { family: 'windows' },
})

const INSTALL_METHODS = ['script', 'package', 'ansible', 'sccm', 'chocolatey', 'other']

export const softwareConfig = (): ResourceConfig => ({
  path: '/software',
  queryKey: 'software',
  singular: T.SINGULAR_SOFTWARE,
  scoped: true,
  columns: [
    { accessor: 'name', Header: T.COL_NAME },
    { accessor: 'version', Header: T.COL_VERSION },
    { accessor: 'vendor', Header: T.COL_VENDOR },
    { accessor: 'install_method', Header: T.COL_INSTALL_METHOD },
  ],
  fields: [
    { key: 'company_id', label: T.FIELD_SCOPE, type: 'scope', immutable: true },
    { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
    { key: 'version', label: T.FIELD_VERSION, type: 'text' },
    { key: 'vendor', label: T.FIELD_VENDOR, type: 'text' },
    { key: 'install_method', label: T.FIELD_INSTALL_METHOD, type: 'select', required: true,
      options: INSTALL_METHODS.map((m) => ({ value: m, label: m })) },
    { key: 'install_ref', label: T.FIELD_INSTALL_REF, type: 'text', help: T.HELP_INSTALL_REF },
    { key: 'description', label: T.FIELD_DESCRIPTION, type: 'textarea' },
  ],
  defaults: { install_method: 'script', operating_system_ids: [] },
})

export const rolesConfig = (): ResourceConfig => ({
  path: '/roles',
  queryKey: 'roles',
  singular: T.SINGULAR_ROLE,
  scoped: true,
  columns: [
    { accessor: 'name', Header: T.COL_NAME },
    { accessor: 'description', Header: T.COL_DESCRIPTION },
  ],
  fields: [
    { key: 'company_id', label: T.FIELD_SCOPE, type: 'scope', immutable: true },
    { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
    { key: 'description', label: T.FIELD_DESCRIPTION, type: 'textarea' },
  ],
})

export const sizesConfig = (): ResourceConfig => ({
  path: '/sizes',
  queryKey: 'sizes',
  singular: T.SINGULAR_SIZE,
  scoped: true,
  columns: [
    { accessor: 'name', Header: T.COL_NAME },
    { accessor: 'vcpu', Header: T.COL_VCPU },
    { accessor: 'cores_per_socket', Header: T.COL_CORES_PER_SOCKET },
    { accessor: 'ram_gb', Header: T.COL_RAM_GB },
  ],
  fields: [
    { key: 'company_id', label: T.FIELD_SCOPE, type: 'scope', immutable: true },
    { key: 'name', label: T.FIELD_NAME, type: 'text', required: true },
    { key: 'vcpu', label: T.FIELD_VCPU, type: 'number', required: true },
    { key: 'cores_per_socket', label: T.FIELD_CORES_PER_SOCKET, type: 'number', required: true },
    { key: 'ram_gb', label: T.FIELD_RAM_GB, type: 'number', required: true },
  ],
  defaults: { vcpu: 2, cores_per_socket: 1, ram_gb: 4 },
})

const pages = (): Record<string, { config: ResourceConfig; title: string; subtitle: string }> => ({
  'operating-systems': { config: osConfig(), title: T.PAGE_OS, subtitle: T.PAGE_OS_SUB },
  software: { config: softwareConfig(), title: T.PAGE_SOFTWARE, subtitle: T.PAGE_SOFTWARE_SUB },
  roles: { config: rolesConfig(), title: T.PAGE_ROLES, subtitle: T.PAGE_ROLES_SUB },
  sizes: { config: sizesConfig(), title: T.PAGE_SIZES, subtitle: T.PAGE_SIZES_SUB },
})

/** Software extra: OS compatibility checklist (empty = all operating systems). */
function OsCompatibility({ form, set }: { form: Row; set: (k: string, v: unknown) => void }) {
  const { data: oses } = useQuery({
    queryKey: ['operating-systems', {}, false],
    queryFn: () => api.get<OperatingSystemType[]>('/operating-systems'),
  })
  const selected = new Set((form.operating_system_ids as UUID[] | undefined) ?? [])
  const toggle = (id: UUID, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    set('operating_system_ids', [...next])
  }
  return (
    <div>
      <strong>{T.FIELD_OS_COMPAT}</strong>
      <p className="vp-muted">{T.HELP_OS_COMPAT}</p>
      <div className="vp-checklist">
        {(oses ?? []).map((o) => (
          <CheckboxField key={o.id} name={`os-${o.id}`} label={osLabel(o)} checked={selected.has(o.id)}
            onChange={(on) => toggle(o.id, on)} />
        ))}
      </div>
    </div>
  )
}

export function CatalogPage({ kind }: { kind: string }) {
  const all = useMemo(pages, [])
  const page = all[kind] ?? all.software
  const [scope, setScope] = useState('all')
  const [archived, setArchived] = useState(false)
  useBreadcrumbs([{ name: T.MENU_CATALOG }, { name: page.title }])
  const isSoftware = kind === 'software'

  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{page.title}</h1>
      <Title title={page.title} subtitle={page.subtitle} />
      <div className="vp-toolbar">
        {page.config.scoped && <ScopeFilter value={scope} onChange={setScope} />}
        <CheckboxField name="show-archived" label={T.SHOW_ARCHIVED} checked={archived} onChange={setArchived} />
      </div>
      <ResourceTable
        key={kind}
        config={page.config}
        params={page.config.scoped ? { scope } : undefined}
        showArchived={archived}
        ownerCompanyId={null}
        afterSave={isSoftware
          ? async (saved, form) => {
              await api.put(`/software/${saved.id}/operating-systems`, {
                operating_system_ids: (form.operating_system_ids as UUID[] | undefined) ?? [],
              })
            }
          : undefined}
        extraForm={isSoftware ? (form, set) => <OsCompatibility form={form} set={set} /> : undefined}
      />
    </div>
  )
}
