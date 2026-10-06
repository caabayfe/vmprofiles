import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Details, Spinner, Title, T } from '@nttdsp/react-components'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type UUID } from '../api'
import { canManage, useLookups, useMe } from '../hooks'
import { useBreadcrumbs } from '../portal'
import { CheckboxField, ErrorText, NumberField, SelectField, TextAreaField, TextField } from '../components/fields'
import { ScopeBadge, ScopeSelect } from '../components/scope'
import type { DiskFormType, LookupsType, NicFormType, ProfileFormType } from '../types'
import { StatusBadge } from './ProfilesPage'

type Form = Omit<ProfileFormType, 'vm_role_id' | 'operating_system_id' | 'vm_size_id' | 'vcenter_id' | 'cluster_id'> & {
  vm_role_id: UUID | null
  operating_system_id: UUID | null
  vm_size_id: UUID | null
  vcenter_id: UUID | null
  cluster_id: UUID | null
}

const STEPS = ['basics', 'compute', 'placement', 'disks', 'network', 'software', 'review'] as const
type Step = (typeof STEPS)[number]

const stepLabel = (s: Step) =>
  ({
    basics: T.STEP_BASICS, compute: T.STEP_COMPUTE, placement: T.STEP_PLACEMENT, disks: T.STEP_DISKS,
    network: T.STEP_NETWORK, software: T.STEP_SOFTWARE, review: T.STEP_REVIEW,
  })[s]

const newDisk = (order: number, windows: boolean): DiskFormType => ({
  disk_order: order,
  label: order === 0 ? 'OS' : `Data ${order}`,
  size_gb: order === 0 ? 80 : 100,
  mount_point: order === 0 ? (windows ? 'C:' : '/') : windows ? `${String.fromCharCode(67 + order)}:` : `/data${order}`,
  filesystem: windows ? 'ntfs' : 'xfs',
  provisioning: 'thin',
  datastore_id: null,
})

const emptyForm = (): Form => ({
  company_id: null, name: '', description: '', status: 'draft',
  vm_role_id: null, operating_system_id: null, vm_size_id: null, vcpu_override: null, ram_gb_override: null,
  vcenter_id: null, cluster_id: null, resource_pool_id: null, vm_folder_id: null, vm_template_id: null,
  naming_pattern: '', notes: '',
  disks: [newDisk(0, true)], nics: [], software: [],
})

/** Everything the cascading pickers need, derived from lookups + current form. */
function useDerived(lookups: LookupsType | undefined, form: Form) {
  return useMemo(() => {
    const vcenter = lookups?.vcenters.find((v) => v.id === form.vcenter_id)
    const clusters = (vcenter?.datacenters ?? []).flatMap((dc) =>
      dc.clusters.map((c) => ({ ...c, label: `${dc.name} / ${c.name}`, folders: dc.folders, dcName: dc.name })),
    )
    const cluster = clusters.find((c) => c.id === form.cluster_id)
    const os = lookups?.operating_systems.find((o) => o.id === form.operating_system_id)
    const size = lookups?.sizes.find((s) => s.id === form.vm_size_id)
    return {
      vcenter, clusters, cluster, os, size,
      role: lookups?.roles.find((r) => r.id === form.vm_role_id),
      pools: cluster?.resource_pools ?? [],
      folders: cluster?.folders ?? [],
      datastores: (vcenter?.datastores ?? []).filter((d) => cluster?.datastore_ids.includes(d.id)),
      networks: (vcenter?.networks ?? []).filter((n) => cluster?.network_ids.includes(n.id)),
      templates: (vcenter?.templates ?? []).filter((t) => t.operating_system_id === form.operating_system_id),
      software: (lookups?.software ?? []).filter(
        (s) => !s.operating_system_ids.length || (form.operating_system_id && s.operating_system_ids.includes(form.operating_system_id)),
      ),
      isWindows: (os?.family ?? 'windows') === 'windows',
    }
  }, [lookups, form])
}

export function ProfileEditor() {
  const { profileId } = useParams()
  const isNew = !profileId || profileId === 'new'
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: me } = useMe()
  const [form, setForm] = useState<Form>(emptyForm)
  const [meta, setMeta] = useState<{ status: string; company_name: string | null; request_count: number } | null>(null)
  const [step, setStep] = useState<Step>('basics')
  const [saveError, setSaveError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const existing = useQuery({
    queryKey: ['profile', profileId],
    queryFn: () => api.get<Form & { status: string; company_name: string | null; request_count: number }>(`/profiles/${profileId}`),
    enabled: !isNew,
  })
  useEffect(() => {
    if (existing.data) {
      const { status, company_name, request_count, ...rest } = existing.data
      setForm({ ...emptyForm(), ...rest, status: status === 'active' ? 'active' : 'draft' })
      setMeta({ status, company_name, request_count })
    }
  }, [existing.data])

  const readOnly = !isNew && !canManage(me, form.company_id)
  const { data: lookups, isLoading: lookupsLoading } = useLookups(form.company_id, isNew || !!existing.data)
  const d = useDerived(lookups, form)

  useBreadcrumbs([
    { name: T.PAGE_PROFILES, link: '/profiles' },
    { name: isNew ? T.ACTION_NEW_PROFILE : form.name || '…' },
  ])

  // When the scope changes, drop references that are no longer usable.
  useEffect(() => {
    if (!lookups || readOnly) return
    setForm((f) => {
      const ok = (id: UUID | null, list: { id: UUID }[]): UUID | null => (id && list.some((x) => x.id === id) ? id : null)
      const vcenter_id = ok(f.vcenter_id, lookups.vcenters)
      const next = {
        ...f,
        vm_role_id: ok(f.vm_role_id, lookups.roles),
        vm_size_id: ok(f.vm_size_id, lookups.sizes),
        vcenter_id,
        software: f.software.filter((s) => lookups.software.some((x) => x.id === s.software_id)),
      }
      if (vcenter_id !== f.vcenter_id) {
        Object.assign(next, { cluster_id: null, resource_pool_id: null, vm_folder_id: null, vm_template_id: null, nics: [] })
      }
      return JSON.stringify(next) === JSON.stringify(f) ? f : next
    })
  }, [lookups, readOnly])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  const changeVcenter = (id: UUID | null) =>
    setForm((f) => ({
      ...f, vcenter_id: id, cluster_id: null, resource_pool_id: null, vm_folder_id: null, vm_template_id: null,
      nics: [], disks: f.disks.map((x) => ({ ...x, datastore_id: null })),
    }))

  const changeCluster = (id: UUID | null) => {
    const c = d.clusters.find((x) => x.id === id)
    setForm((f) => ({
      ...f, cluster_id: id, resource_pool_id: null,
      vm_folder_id: c?.folders.some((x) => x.id === f.vm_folder_id) ? f.vm_folder_id : null,
      disks: f.disks.map((x) => ({ ...x, datastore_id: x.datastore_id && c?.datastore_ids.includes(x.datastore_id) ? x.datastore_id : null })),
      nics: f.nics.filter((n) => c?.network_ids.includes(n.network_id)),
    }))
  }

  const changeOs = (id: UUID | null) => {
    const os = lookups?.operating_systems.find((o) => o.id === id)
    const windows = (os?.family ?? 'windows') === 'windows'
    setForm((f) => ({
      ...f,
      operating_system_id: id,
      vm_template_id: null,
      software: f.software.filter((s) => {
        const sw = lookups?.software.find((x) => x.id === s.software_id)
        return !sw?.operating_system_ids.length || (!!id && sw.operating_system_ids.includes(id))
      }),
      // Re-default untouched OS disk mount points when switching family.
      disks: f.disks.map((x) =>
        x.disk_order === 0 && (x.mount_point === 'C:' || x.mount_point === '/')
          ? { ...x, mount_point: windows ? 'C:' : '/', filesystem: windows ? 'ntfs' : 'xfs' }
          : x,
      ),
    }))
  }

  const changeTemplate = (id: UUID | null) => {
    const tpl = d.templates.find((t) => t.id === id)
    setForm((f) => ({
      ...f, vm_template_id: id,
      disks: f.disks.map((x) => (x.disk_order === 0 && tpl?.os_disk_gb ? { ...x, size_gb: tpl.os_disk_gb } : x)),
    }))
  }

  const setDisk = (i: number, patch: Partial<DiskFormType>) =>
    setForm((f) => ({ ...f, disks: f.disks.map((x, j) => (j === i ? { ...x, ...patch } : x)) }))
  const setNic = (i: number, patch: Partial<NicFormType>) =>
    setForm((f) => ({ ...f, nics: f.nics.map((x, j) => (j === i ? { ...x, ...patch } : x)) }))

  const stepValid: Record<Step, boolean> = {
    basics: !!form.name.trim() && !!form.vm_role_id,
    compute: !!form.operating_system_id && !!form.vm_size_id,
    placement: !!form.vcenter_id && !!form.cluster_id,
    disks: form.disks.length > 0 && form.disks.every((x) => x.size_gb > 0 && x.mount_point.trim()),
    network: form.nics.length > 0 && form.nics.every((n) => !!n.network_id),
    software: true,
    review: true,
  }
  const firstInvalid = STEPS.find((s) => !stepValid[s])
  const stepIndex = STEPS.indexOf(step)
  const reachable = (s: Step) => STEPS.indexOf(s) <= (firstInvalid ? STEPS.indexOf(firstInvalid) : STEPS.length)

  const save = async (activate: boolean) => {
    setBusy(true)
    setSaveError(null)
    try {
      const payload = {
        ...form,
        status: activate ? 'active' : form.status,
        disks: form.disks.map((x, i) => ({ ...x, disk_order: i })),
        nics: form.nics.map((n, i) => ({ ...n, nic_order: i })),
        software: form.software.map((s, i) => ({ ...s, install_order: i + 1 })),
      }
      const res = isNew
        ? await api.post<{ id: UUID }>('/profiles', payload)
        : await api.put<{ id: UUID }>(`/profiles/${profileId}`, payload)
      await qc.invalidateQueries({ queryKey: ['profiles'] })
      await qc.invalidateQueries({ queryKey: ['profile', res.id] })
      navigate('/profiles')
    } catch (e) {
      setSaveError(e)
    } finally {
      setBusy(false)
    }
  }

  if (!isNew && (existing.isLoading || !meta)) return <Spinner />
  if (existing.error) return <div className="vp-page"><ErrorText error={existing.error} /></div>

  const opt = <X extends { id: UUID }>(list: X[], label: (x: X) => string) => list.map((x) => ({ value: x.id, label: label(x) }))
  const title = isNew ? T.ACTION_NEW_PROFILE : form.name

  const renderStep = () => {
    switch (step) {
      case 'basics':
        return (
          <div className="vp-form">
            <ScopeSelect value={form.company_id} disabled={!isNew || readOnly} onChange={(v) => set('company_id', v)} label={T.FIELD_PROFILE_SCOPE} />
            {!isNew && <p className="vp-muted">{T.HELP_SCOPE_IMMUTABLE}</p>}
            <TextField label={T.FIELD_NAME} required value={form.name} disabled={readOnly} onChange={(v) => set('name', v)} />
            <SelectField label={T.FIELD_ROLE} required value={form.vm_role_id} disabled={readOnly}
              options={opt(lookups?.roles ?? [], (r) => (r.company_id ? `${r.name} ★` : r.name))}
              onChange={(v) => set('vm_role_id', v)} help={T.HELP_STAR_COMPANY} />
            <TextAreaField label={T.FIELD_DESCRIPTION} value={form.description} disabled={readOnly} onChange={(v) => set('description', v)} />
            <TextField label={T.FIELD_NAMING_PATTERN} value={form.naming_pattern} disabled={readOnly} help={T.HELP_NAMING_PATTERN}
              onChange={(v) => set('naming_pattern', v)} />
          </div>
        )
      case 'compute':
        return (
          <div className="vp-form">
            <SelectField label={T.FIELD_OS} required value={form.operating_system_id} disabled={readOnly}
              options={opt(lookups?.operating_systems ?? [], (o) => `${o.name} ${o.version}`)} onChange={changeOs} />
            <SelectField label={T.FIELD_SIZE} required value={form.vm_size_id} disabled={readOnly}
              options={opt(lookups?.sizes ?? [], (s) => `${s.name} — ${s.vcpu} vCPU / ${s.ram_gb} GB${s.company_id ? ' ★' : ''}`)}
              onChange={(v) => set('vm_size_id', v)} />
            <div className="vp-form-2">
              <NumberField label={T.FIELD_VCPU_OVERRIDE} min={1} value={form.vcpu_override} disabled={readOnly}
                help={d.size ? `${T.HELP_PRESET}: ${d.size.vcpu}` : undefined} onChange={(v) => set('vcpu_override', v)} />
              <NumberField label={T.FIELD_RAM_OVERRIDE} min={1} value={form.ram_gb_override} disabled={readOnly}
                help={d.size ? `${T.HELP_PRESET}: ${d.size.ram_gb}` : undefined} onChange={(v) => set('ram_gb_override', v)} />
            </div>
          </div>
        )
      case 'placement':
        return (
          <div className="vp-form">
            <SelectField label={T.FIELD_VCENTER} required value={form.vcenter_id} disabled={readOnly}
              options={opt(lookups?.vcenters ?? [], (v) => `${v.name} (${v.fqdn})${v.company_id ? ' ★' : ''}`)} onChange={changeVcenter} />
            <SelectField label={T.FIELD_CLUSTER} required value={form.cluster_id} disabled={readOnly || !form.vcenter_id}
              options={d.clusters.map((c) => ({ value: c.id, label: c.label }))} onChange={changeCluster} />
            <SelectField label={T.FIELD_POOL} value={form.resource_pool_id} disabled={readOnly || !form.cluster_id}
              emptyLabel={T.NONE_OPTION} options={opt(d.pools, (p) => p.path || p.name)} onChange={(v) => set('resource_pool_id', v)} />
            <SelectField label={T.FIELD_FOLDER} value={form.vm_folder_id} disabled={readOnly || !form.cluster_id}
              emptyLabel={T.NONE_OPTION} options={opt(d.folders, (f) => f.path)} onChange={(v) => set('vm_folder_id', v)} />
            <SelectField label={T.FIELD_TEMPLATE} value={form.vm_template_id} disabled={readOnly || !form.vcenter_id || !form.operating_system_id}
              emptyLabel={T.NONE_OPTION} help={T.HELP_TEMPLATE} options={opt(d.templates, (t) => t.name)} onChange={changeTemplate} />
            {form.cluster_id && (
              <p className="vp-muted">
                {T.HELP_CLUSTER_ATTACHED}: {d.datastores.length} {T.TAB_DATASTORES.toLowerCase()}, {d.networks.length} {T.TAB_NETWORKS.toLowerCase()}
              </p>
            )}
          </div>
        )
      case 'disks':
        return (
          <div className="vp-form">
            {form.disks.map((disk, i) => (
              <div key={i} className="vp-grid-row" style={{ gridTemplateColumns: '0.8fr 0.6fr 0.8fr 0.6fr 0.9fr 1.2fr auto' }}>
                <TextField label={i === 0 ? T.FIELD_DISK_LABEL_OS : T.FIELD_DISK_LABEL} value={disk.label} disabled={readOnly} onChange={(v) => setDisk(i, { label: v })} />
                <NumberField label={T.FIELD_SIZE_GB} required min={1} value={disk.size_gb} disabled={readOnly} onChange={(v) => setDisk(i, { size_gb: v ?? 0 })} />
                <TextField label={T.FIELD_MOUNT} required value={disk.mount_point} disabled={readOnly} onChange={(v) => setDisk(i, { mount_point: v })} />
                <TextField label={T.FIELD_FILESYSTEM} value={disk.filesystem} disabled={readOnly} onChange={(v) => setDisk(i, { filesystem: v })} />
                <SelectField label={T.FIELD_PROVISIONING} allowEmpty={false} value={disk.provisioning} disabled={readOnly}
                  options={[{ value: 'thin', label: 'Thin' }, { value: 'thick_lazy', label: 'Thick lazy-zeroed' }, { value: 'thick_eager', label: 'Thick eager-zeroed' }]}
                  onChange={(v) => setDisk(i, { provisioning: (v ?? 'thin') as DiskFormType['provisioning'] })} />
                <SelectField label={T.FIELD_DATASTORE} value={disk.datastore_id} disabled={readOnly || !form.cluster_id} emptyLabel={T.DATASTORE_DEFAULT}
                  options={opt(d.datastores, (s) => s.name)} onChange={(v) => setDisk(i, { datastore_id: v })} />
                <Button appearance="text" disabled={readOnly || form.disks.length === 1}
                  onClick={() => set('disks', form.disks.filter((_, j) => j !== i))}>{T.ACTION_REMOVE}</Button>
              </div>
            ))}
            {!readOnly && (
              <div>
                <Button appearance="neutral" onClick={() => set('disks', [...form.disks, newDisk(form.disks.length, d.isWindows)])}>
                  {T.ACTION_ADD_DISK}
                </Button>
              </div>
            )}
            <p className="vp-muted">{T.TOTAL}: {form.disks.reduce((a, x) => a + (x.size_gb || 0), 0)} GB</p>
          </div>
        )
      case 'network':
        return (
          <div className="vp-form">
            {!form.cluster_id && <p className="vp-muted">{T.HELP_PICK_CLUSTER_FIRST}</p>}
            {form.nics.map((nic, i) => (
              <div key={i} className="vp-grid-row" style={{ gridTemplateColumns: '2fr 1fr auto' }}>
                <SelectField label={`${T.FIELD_NETWORK} ${i + 1}`} required value={nic.network_id || null} disabled={readOnly}
                  options={opt(d.networks, (n) => `${n.name}${n.vlan_id !== null ? ` (VLAN ${n.vlan_id})` : ''}`)}
                  onChange={(v) => setNic(i, { network_id: v ?? '' })} />
                <SelectField label={T.FIELD_ADAPTER} allowEmpty={false} value={nic.adapter_type} disabled={readOnly}
                  options={[{ value: 'vmxnet3', label: 'VMXNET3' }, { value: 'e1000e', label: 'E1000E' }]}
                  onChange={(v) => setNic(i, { adapter_type: (v ?? 'vmxnet3') as NicFormType['adapter_type'] })} />
                <Button appearance="text" disabled={readOnly} onClick={() => set('nics', form.nics.filter((_, j) => j !== i))}>{T.ACTION_REMOVE}</Button>
              </div>
            ))}
            {!readOnly && form.cluster_id && form.nics.length < 10 && (
              <div>
                <Button appearance="neutral" onClick={() => set('nics', [...form.nics, { nic_order: form.nics.length, network_id: d.networks[0]?.id ?? '', adapter_type: 'vmxnet3' }])}>
                  {T.ACTION_ADD_NIC}
                </Button>
              </div>
            )}
          </div>
        )
      case 'software': {
        const chosen = new Map(form.software.map((s) => [s.software_id, s]))
        const toggle = (id: UUID, on: boolean) =>
          set('software', on
            ? [...form.software, { software_id: id, install_order: form.software.length + 1, is_mandatory: true }]
            : form.software.filter((s) => s.software_id !== id))
        const move = (i: number, delta: number) => {
          const list = [...form.software]
          const j = i + delta
          if (j < 0 || j >= list.length) return
          ;[list[i], list[j]] = [list[j], list[i]]
          set('software', list)
        }
        return (
          <div className="vp-form-2">
            <div>
              <h2 className="main-heading">{T.SOFTWARE_AVAILABLE}</h2>
              <p className="vp-muted">{T.HELP_SOFTWARE_SCOPE}</p>
              <div className="vp-checklist">
                {d.software.map((s) => (
                  <CheckboxField key={s.id} name={`sw-${s.id}`} disabled={readOnly} checked={chosen.has(s.id)}
                    label={<>{s.name} {s.version} {s.company_id ? <Badge appearance="info">{T.SCOPE_COMPANY}</Badge> : null}</>}
                    onChange={(on) => toggle(s.id, on)} />
                ))}
              </div>
            </div>
            <div>
              <h2 className="main-heading">{T.SOFTWARE_SELECTED}</h2>
              {form.software.length === 0 && <p className="vp-muted">{T.NO_SOFTWARE}</p>}
              {form.software.map((s, i) => {
                const sw = lookups?.software.find((x) => x.id === s.software_id)
                return (
                  <div key={s.software_id} className="vp-grid-row" style={{ gridTemplateColumns: 'auto 1fr auto auto auto', alignItems: 'center' }}>
                    <span className="vp-muted">{i + 1}.</span>
                    <span>{sw ? `${sw.name} ${sw.version}` : s.software_id}</span>
                    <CheckboxField name={`mand-${s.software_id}`} label={T.FIELD_MANDATORY} checked={s.is_mandatory} disabled={readOnly}
                      onChange={(on) => set('software', form.software.map((x) => (x.software_id === s.software_id ? { ...x, is_mandatory: on } : x)))} />
                    <Button appearance="text" disabled={readOnly || i === 0} onClick={() => move(i, -1)}>{T.ACTION_UP}</Button>
                    <Button appearance="text" disabled={readOnly || i === form.software.length - 1} onClick={() => move(i, 1)}>{T.ACTION_DOWN}</Button>
                  </div>
                )
              })}
            </div>
          </div>
        )
      }
      case 'review':
        return (
          <>
            <Details data={[
              { label: T.FIELD_PROFILE_SCOPE, value: <ScopeBadge companyName={meta?.company_name ?? (form.company_id ? T.SCOPE_COMPANY : null)} /> },
              { label: T.FIELD_NAME, value: form.name },
              { label: T.FIELD_ROLE, value: d.role?.name },
              { label: T.FIELD_OS, value: d.os ? `${d.os.name} ${d.os.version}` : undefined },
              { label: T.COL_COMPUTE, value: d.size ? `${form.vcpu_override ?? d.size.vcpu} vCPU · ${form.ram_gb_override ?? d.size.ram_gb} GB (${d.size.name}${form.vcpu_override || form.ram_gb_override ? `, ${T.OVERRIDDEN}` : ''})` : undefined },
              { label: T.COL_PLACEMENT, value: d.vcenter && d.cluster ? `${d.vcenter.name} / ${d.cluster.label}` : undefined },
              { label: T.FIELD_POOL, value: d.pools.find((p) => p.id === form.resource_pool_id)?.name },
              { label: T.FIELD_FOLDER, value: d.folders.find((f) => f.id === form.vm_folder_id)?.path },
              { label: T.FIELD_TEMPLATE, value: d.templates.find((t) => t.id === form.vm_template_id)?.name },
              { label: T.STEP_DISKS, value: form.disks.map((x) => `${x.mount_point} ${x.size_gb} GB`).join(' · ') },
              { label: T.STEP_NETWORK, value: form.nics.map((n) => d.networks.find((x) => x.id === n.network_id)?.name ?? '?').join(' · ') },
              { label: T.STEP_SOFTWARE, value: form.software.map((s) => {
                  const sw = lookups?.software.find((x) => x.id === s.software_id)
                  return `${sw?.name ?? '?'}${s.is_mandatory ? '' : ` (${T.OPTIONAL})`}`
                }).join(' · ') || undefined },
            ]} />
            {!readOnly && <div className="vp-section"><TextAreaField label={T.FIELD_NOTES} value={form.notes} onChange={(v) => set('notes', v)} /></div>}
            {firstInvalid && <p className="vp-error">{T.FIX_STEP}: {stepLabel(firstInvalid)}</p>}
          </>
        )
    }
  }

  return (
    <div className="grid-container--fluid vp-page">
      <h1 className="main-heading no-margin sr-only">{title}</h1>
      <Title title={title} subtitle={readOnly ? T.READ_ONLY_HINT : T.PAGE_PROFILE_EDITOR_SUB}>
        {meta && <StatusBadge status={meta.status} />}
      </Title>
      {meta && meta.request_count > 0 && <p className="vp-muted">{T.HELP_PROFILE_HAS_REQUESTS}</p>}
      <nav className="vp-steps" aria-label={T.STEPS_LABEL}>
        {STEPS.map((s, i) => (
          <button key={s} type="button" className="vp-step" aria-current={s === step ? 'step' : undefined}
            disabled={!readOnly && !reachable(s)} onClick={() => setStep(s)}>
            {i + 1}. {stepLabel(s)}
          </button>
        ))}
      </nav>
      {lookupsLoading ? <Spinner /> : renderStep()}
      <ErrorText error={saveError} />
      <div className="vp-actions">
        <Button appearance="neutral" onClick={() => navigate('/profiles')}>{T.ACTION_CANCEL}</Button>
        {stepIndex > 0 && <Button appearance="neutral" onClick={() => setStep(STEPS[stepIndex - 1])}>{T.ACTION_BACK}</Button>}
        {step !== 'review' && (
          <Button appearance="primary" disabled={!readOnly && !stepValid[step]} onClick={() => setStep(STEPS[stepIndex + 1])}>
            {T.ACTION_NEXT}
          </Button>
        )}
        {step === 'review' && !readOnly && (
          <>
            <Button appearance="neutral" disabled={busy || !!firstInvalid} onClick={() => save(false)}>
              {meta?.status === 'active' ? T.ACTION_SAVE : T.ACTION_SAVE_DRAFT}
            </Button>
            {meta?.status !== 'active' && meta?.status !== 'archived' && (
              <Button appearance="primary" disabled={busy || !!firstInvalid} onClick={() => save(true)}>{T.ACTION_SAVE_ACTIVATE}</Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
