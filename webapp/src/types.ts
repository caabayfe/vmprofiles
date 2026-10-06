import type { UUID } from './api'

// `[key: string]: unknown` lets these rows satisfy BaseTable's TableRowType.
export interface Row {
  [key: string]: unknown
}

export interface MeType {
  user_id: UUID
  user_name: string
  is_global_admin: boolean
  is_admin: boolean
  has_access: boolean
  companies: { id: UUID; name: string; role: 'company_admin' | 'requester' }[]
}

export interface CompanyType extends Row {
  id: UUID
  name: string
  code: string
}

export interface OperatingSystemType extends Row {
  id: UUID
  family: 'windows' | 'linux'
  name: string
  version: string
  vmware_guest_id: string
}

export interface LookupSoftwareType extends Row {
  id: UUID
  name: string
  version: string
  vendor: string
  install_method: string
  company_id: UUID | null
  operating_system_ids: UUID[]
}

export interface ClusterLookupType {
  id: UUID
  name: string
  datacenter_id: UUID
  cpu_total_mhz: number | null
  cpu_used_mhz: number | null
  memory_total_gb: number | null
  memory_used_gb: number | null
  /** Derived by the API: total - used. */
  memory_free_gb: number | null
  capacity_updated_at: string | null
  resource_pools: {
    id: UUID
    name: string
    path: string
    memory_limit_gb: number | null
    memory_used_gb: number | null
    /** Derived by the API: limit - used; null when unlimited or unknown. */
    memory_free_gb: number | null
  }[]
  datastore_ids: UUID[]
  network_ids: UUID[]
}

export interface VcenterLookupType {
  id: UUID
  name: string
  fqdn: string
  company_id: UUID | null
  datacenters: {
    id: UUID
    name: string
    clusters: ClusterLookupType[]
    folders: { id: UUID; path: string }[]
  }[]
  datastores: { id: UUID; name: string; type: string; capacity_gb: number | null; used_gb: number | null; free_gb: number | null }[]
  networks: {
    id: UUID
    name: string
    type: string
    vlan_id: number | null
    subnet_cidr: string | null
    gateway: string | null
    ip_pool_start: string | null
    ip_free: number | null
  }[]
  templates: { id: UUID; name: string; operating_system_id: UUID; os_disk_gb: number | null }[]
}

export interface LookupsType {
  company_id: UUID | null
  roles: { id: UUID; name: string; company_id: UUID | null }[]
  sizes: { id: UUID; name: string; vcpu: number; cores_per_socket: number; ram_gb: number; company_id: UUID | null }[]
  operating_systems: OperatingSystemType[]
  software: LookupSoftwareType[]
  vcenters: VcenterLookupType[]
}

export interface DiskFormType {
  disk_order: number
  label: string
  size_gb: number
  mount_point: string
  filesystem: string
  provisioning: 'thin' | 'thick_lazy' | 'thick_eager'
  datastore_id: UUID | null
}

export interface NicFormType {
  nic_order: number
  network_id: UUID
  adapter_type: 'vmxnet3' | 'e1000e'
  alternative_network_ids: UUID[]
}

export interface SoftwareFormType {
  software_id: UUID
  install_order: number
  is_mandatory: boolean
}

export interface ProfileFormType {
  company_id: UUID | null
  name: string
  description: string
  status: 'draft' | 'active'
  vm_role_id: UUID
  operating_system_id: UUID
  vm_size_id: UUID
  vcpu_override: number | null
  ram_gb_override: number | null
  vcenter_id: UUID
  cluster_id: UUID
  resource_pool_id: UUID | null
  vm_folder_id: UUID | null
  vm_template_id: UUID | null
  naming_pattern: string
  notes: string
  allowed_size_ids: UUID[]
  max_extra_disks: number
  max_extra_disk_gb: number
  disks: DiskFormType[]
  nics: NicFormType[]
  software: SoftwareFormType[]
}

export interface ProfileListType extends Row {
  id: UUID
  name: string
  description: string
  status: 'draft' | 'active' | 'archived'
  company_id: UUID | null
  company_name: string | null
  role_name: string
  os_family: string
  os_name: string
  size_name: string
  vcpu: number
  ram_gb: number
  vcenter_name: string
  cluster_name: string
  disk_total_gb: number
  disk_count: number
  software_count: number
  updated_at: string
}

interface Ref {
  id: UUID
  name?: string
}

export interface ExpandedProfileType {
  id: UUID
  name: string
  description: string
  status: string
  company: (Ref & { name: string }) | null
  role: Ref
  operating_system: Ref & { family: string; version: string; vmware_guest_id: string }
  compute: { size: Ref; vcpu: number; cores_per_socket: number; ram_gb: number; overridden: boolean }
  placement: {
    vcenter: Ref & { fqdn: string }
    datacenter: Ref
    cluster: Ref
    resource_pool: (Ref & { path: string }) | null
    folder: { id: UUID; path: string } | null
    template: (Ref & { content_library: string }) | null
  }
  disks: (Omit<DiskFormType, 'datastore_id'> & { datastore: Ref | null })[]
  disk_total_gb: number
  nics: { nic_order: number; adapter_type: string; network: NetworkInfoType }[]
  software: {
    id: UUID
    name: string
    version: string
    vendor: string
    install_method: string
    install_ref: string
    install_order: number
    is_mandatory: boolean
    scope: 'global' | 'company'
  }[]
  naming_pattern: string
  notes: string
  warnings: string[]
  adjustable?: {
    sizes: SizeOptionType[]
    max_extra_disks: number
    max_extra_disk_gb: number
    datastores: { id: UUID; name: string; free_gb: number | null }[]
    nic_options: { nic_order: number; networks: NetworkInfoType[] }[]
  }
  request?: { hostname: string; quantity: number; hostnames: string[] }
  adjustments?: {
    size?: { from: string; to: string }
    extra_disks?: { mount_point: string; size_gb: number }[]
    networks?: { nic_order: number; from: string; to: string }[]
    excluded_software?: string[]
  }
  capacity_check?: { checked_at: string; warnings: string[] }
  instances?: InstanceType[]
}

export interface SizeOptionType {
  id: UUID
  name: string
  vcpu: number
  cores_per_socket: number
  ram_gb: number
}

export interface NetworkInfoType {
  id: UUID
  name: string
  vlan_id: number | null
  type: string
  addressing: 'static' | 'dhcp'
  subnet_cidr: string | null
  gateway: string | null
  dns_servers: string[]
  dns_domain: string
}

export interface InstanceType {
  hostname: string
  nics: {
    nic_order: number
    network_name: string
    addressing: 'static' | 'dhcp'
    ip: string | null
    prefix_length: number | null
    gateway: string | null
    dns_servers: string[]
    dns_domain: string
  }[]
}

export interface RequestListType extends Row {
  id: UUID
  company_id: UUID
  company_name: string
  profile_name: string
  hostname: string
  quantity: number
  status: string
  requested_by_name: string
  submitted_at: string | null
  decided_by_name: string
  decided_at: string | null
  created_at: string
}

export interface RequestDetailType extends RequestListType {
  justification: string
  status_reason: string
  spec: ExpandedProfileType
  can_decide: boolean
  capacity_now?: string[]
  events: { from_status: string; to_status: string; user_name: string; comment: string; created_at: string }[]
}
