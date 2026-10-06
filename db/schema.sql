-- vm-profiles — `db` component schema (source of truth)
--
-- pgschema diffs this file against the live DB on every `yarp db-migrate`
-- and applies the minimum DDL to converge. Seed / bootstrap rows live in
-- data/post/. See yarp_guide_get("db-migrations").
--
-- Tenancy pattern (used everywhere): a nullable company_id.
--   NULL  -> global (visible to every company)
--   value -> the Digital Fabric company UUID that owns the row
-- Visibility for company X is always: company_id IS NULL OR company_id = X.
--
-- VMware hierarchy integrity is enforced with composite foreign keys, so a
-- profile can never point at a resource pool from another cluster, a
-- datastore not attached to its cluster, a folder from another datacenter, …
-- Scope consistency (global profile -> global items only) is enforced in the
-- API (api/scope.py) because it spans several tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Companies (display cache of Digital Fabric companies this app uses)
-- ---------------------------------------------------------------------------
-- The backend container cannot call the DF directory, so the SPA picks a
-- company from DF and upserts {id, name} here. id IS the DF company UUID.
CREATE TABLE IF NOT EXISTS companies (
    id          uuid        NOT NULL,
    name        text        NOT NULL,
    code        text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT companies_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- Access: app-local role assignments keyed by DF user_id
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_assignments (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,
    user_name   text        NOT NULL DEFAULT '',
    user_email  text        NOT NULL DEFAULT '',
    role        text        NOT NULL,
    company_id  uuid,
    created_by  uuid        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT role_assignments_pkey PRIMARY KEY (id),
    -- inventory_sync: machine role for external inventory feeds. Global
    -- (company_id NULL) may sync any vCenter; company-scoped only that
    -- company's vCenters.
    CONSTRAINT role_assignments_role_check
        CHECK (role IN ('global_admin', 'company_admin', 'requester', 'inventory_sync')),
    CONSTRAINT role_assignments_company_check
        CHECK (role = 'inventory_sync' OR (role = 'global_admin') = (company_id IS NULL)),
    CONSTRAINT role_assignments_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS role_assignments_global_uq
    ON role_assignments (user_id, role) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS role_assignments_company_uq
    ON role_assignments (user_id, role, company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS role_assignments_company_id_idx ON role_assignments (company_id);

-- ---------------------------------------------------------------------------
-- VMware infrastructure catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vcenters (
    id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
    company_id             uuid,
    name                   text        NOT NULL,
    fqdn                   text        NOT NULL,
    description            text        NOT NULL DEFAULT '',
    credential_secret_name text        NOT NULL DEFAULT '',
    external_moref         text,
    is_active              boolean     NOT NULL DEFAULT true,
    created_by             uuid        NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_by             uuid,
    updated_at             timestamptz,
    CONSTRAINT vcenters_pkey PRIMARY KEY (id),
    CONSTRAINT vcenters_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS vcenters_global_name_uq ON vcenters (name) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vcenters_company_name_uq ON vcenters (company_id, name) WHERE company_id IS NOT NULL;
-- FQDN identifies a vCenter for inventory syncs (one per scope).
CREATE UNIQUE INDEX IF NOT EXISTS vcenters_global_fqdn_uq ON vcenters (lower(fqdn)) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vcenters_company_fqdn_uq ON vcenters (company_id, lower(fqdn)) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vcenters_company_id_idx ON vcenters (company_id);

CREATE TABLE IF NOT EXISTS datacenters (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    vcenter_id     uuid        NOT NULL,
    name           text        NOT NULL,
    external_moref text,
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT datacenters_pkey PRIMARY KEY (id),
    CONSTRAINT datacenters_vcenter_id_fkey
        FOREIGN KEY (vcenter_id) REFERENCES vcenters (id) ON DELETE RESTRICT,
    CONSTRAINT datacenters_vcenter_name_uq UNIQUE (vcenter_id, name),
    CONSTRAINT datacenters_vcenter_id_id_uq UNIQUE (vcenter_id, id)
);

CREATE TABLE IF NOT EXISTS clusters (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    vcenter_id     uuid        NOT NULL,
    datacenter_id  uuid        NOT NULL,
    name           text        NOT NULL,
    external_moref text,
    -- Capacity as total + used (from the inventory feed or typed in);
    -- NULL = unknown. Checks use free = total - used.
    cpu_total_mhz       integer,
    cpu_used_mhz        integer,
    memory_total_gb     integer,
    memory_used_gb      integer,
    capacity_updated_at timestamptz,
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT clusters_pkey PRIMARY KEY (id),
    CONSTRAINT clusters_capacity_check CHECK (
        (cpu_total_mhz IS NULL OR cpu_total_mhz > 0) AND (cpu_used_mhz IS NULL OR cpu_used_mhz >= 0)
        AND (memory_total_gb IS NULL OR memory_total_gb > 0) AND (memory_used_gb IS NULL OR memory_used_gb >= 0)),
    -- vcenter_id is denormalised so composite FKs below can pin a child to
    -- the same vCenter; this FK keeps it honest with the datacenter's.
    CONSTRAINT clusters_datacenter_fkey
        FOREIGN KEY (vcenter_id, datacenter_id) REFERENCES datacenters (vcenter_id, id) ON DELETE RESTRICT,
    CONSTRAINT clusters_datacenter_name_uq UNIQUE (datacenter_id, name),
    CONSTRAINT clusters_vcenter_id_id_uq UNIQUE (vcenter_id, id),
    CONSTRAINT clusters_id_datacenter_id_uq UNIQUE (id, datacenter_id)
);
CREATE INDEX IF NOT EXISTS clusters_datacenter_id_idx ON clusters (datacenter_id);
-- Capacity moved from "free" to "total + used".
-- @allow-drop clusters.cpu_cores
-- @allow-drop clusters.memory_free_gb
CREATE INDEX IF NOT EXISTS clusters_vcenter_datacenter_idx ON clusters (vcenter_id, datacenter_id);

CREATE TABLE IF NOT EXISTS resource_pools (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    cluster_id     uuid        NOT NULL,
    name           text        NOT NULL,
    path           text        NOT NULL DEFAULT '',
    -- Reservation limits + usage; NULL limit = unlimited (inherits the cluster).
    cpu_limit_mhz       integer,
    cpu_used_mhz        integer,
    memory_limit_gb     integer,
    memory_used_gb      integer,
    capacity_updated_at timestamptz,
    external_moref text,
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT resource_pools_pkey PRIMARY KEY (id),
    CONSTRAINT resource_pools_capacity_check CHECK (
        (cpu_limit_mhz IS NULL OR cpu_limit_mhz > 0) AND (cpu_used_mhz IS NULL OR cpu_used_mhz >= 0)
        AND (memory_limit_gb IS NULL OR memory_limit_gb > 0) AND (memory_used_gb IS NULL OR memory_used_gb >= 0)),
    CONSTRAINT resource_pools_cluster_id_fkey
        FOREIGN KEY (cluster_id) REFERENCES clusters (id) ON DELETE RESTRICT,
    CONSTRAINT resource_pools_cluster_name_uq UNIQUE (cluster_id, name),
    CONSTRAINT resource_pools_cluster_id_id_uq UNIQUE (cluster_id, id)
);

CREATE TABLE IF NOT EXISTS datastores (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    vcenter_id     uuid        NOT NULL,
    name           text        NOT NULL,
    type           text        NOT NULL DEFAULT 'vmfs',
    capacity_gb    integer,
    used_gb        integer,
    capacity_updated_at timestamptz,
    external_moref text,
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT datastores_pkey PRIMARY KEY (id),
    CONSTRAINT datastores_used_check CHECK (used_gb IS NULL OR used_gb >= 0),
    CONSTRAINT datastores_vcenter_id_fkey
        FOREIGN KEY (vcenter_id) REFERENCES vcenters (id) ON DELETE RESTRICT,
    CONSTRAINT datastores_type_check CHECK (type IN ('vmfs', 'nfs', 'vsan', 'vvol')),
    CONSTRAINT datastores_capacity_check CHECK (capacity_gb IS NULL OR capacity_gb > 0),
    CONSTRAINT datastores_vcenter_name_uq UNIQUE (vcenter_id, name),
    CONSTRAINT datastores_vcenter_id_id_uq UNIQUE (vcenter_id, id)
);

-- A datastore belongs to the vCenter and is attached to one or more clusters.
-- @allow-drop datastores.free_gb

CREATE TABLE IF NOT EXISTS clusters_datastores (
    vcenter_id   uuid NOT NULL,
    cluster_id   uuid NOT NULL,
    datastore_id uuid NOT NULL,
    CONSTRAINT clusters_datastores_pkey PRIMARY KEY (cluster_id, datastore_id),
    CONSTRAINT clusters_datastores_cluster_fkey
        FOREIGN KEY (vcenter_id, cluster_id) REFERENCES clusters (vcenter_id, id) ON DELETE RESTRICT,
    CONSTRAINT clusters_datastores_datastore_fkey
        FOREIGN KEY (vcenter_id, datastore_id) REFERENCES datastores (vcenter_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS clusters_datastores_datastore_id_idx ON clusters_datastores (datastore_id);
CREATE INDEX IF NOT EXISTS clusters_datastores_vcenter_cluster_idx ON clusters_datastores (vcenter_id, cluster_id);
CREATE INDEX IF NOT EXISTS clusters_datastores_vcenter_datastore_idx ON clusters_datastores (vcenter_id, datastore_id);

CREATE TABLE IF NOT EXISTS networks (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    vcenter_id     uuid        NOT NULL,
    name           text        NOT NULL,
    type           text        NOT NULL DEFAULT 'dvportgroup',
    vlan_id        integer,
    -- IP details. No pool = DHCP / addressed outside this app.
    subnet_cidr    cidr,
    gateway        inet,
    dns_servers    text[]      NOT NULL DEFAULT '{}',
    dns_domain     text        NOT NULL DEFAULT '',
    ip_pool_start  inet,
    ip_pool_end    inet,
    external_moref text,
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT networks_pkey PRIMARY KEY (id),
    CONSTRAINT networks_gateway_check CHECK (gateway IS NULL OR (subnet_cidr IS NOT NULL AND gateway << subnet_cidr)),
    CONSTRAINT networks_pool_check CHECK (
        (ip_pool_start IS NULL) = (ip_pool_end IS NULL)
        AND (ip_pool_start IS NULL OR (subnet_cidr IS NOT NULL AND ip_pool_start << subnet_cidr
             AND ip_pool_end << subnet_cidr AND ip_pool_start <= ip_pool_end))),
    CONSTRAINT networks_vcenter_id_fkey
        FOREIGN KEY (vcenter_id) REFERENCES vcenters (id) ON DELETE RESTRICT,
    CONSTRAINT networks_type_check CHECK (type IN ('standard', 'dvportgroup', 'nsx')),
    CONSTRAINT networks_vlan_check CHECK (vlan_id IS NULL OR (vlan_id >= 0 AND vlan_id <= 4094)),
    CONSTRAINT networks_vcenter_name_uq UNIQUE (vcenter_id, name),
    CONSTRAINT networks_vcenter_id_id_uq UNIQUE (vcenter_id, id)
);

CREATE TABLE IF NOT EXISTS clusters_networks (
    vcenter_id uuid NOT NULL,
    cluster_id uuid NOT NULL,
    network_id uuid NOT NULL,
    CONSTRAINT clusters_networks_pkey PRIMARY KEY (cluster_id, network_id),
    CONSTRAINT clusters_networks_cluster_fkey
        FOREIGN KEY (vcenter_id, cluster_id) REFERENCES clusters (vcenter_id, id) ON DELETE RESTRICT,
    CONSTRAINT clusters_networks_network_fkey
        FOREIGN KEY (vcenter_id, network_id) REFERENCES networks (vcenter_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS clusters_networks_network_id_idx ON clusters_networks (network_id);
CREATE INDEX IF NOT EXISTS clusters_networks_vcenter_cluster_idx ON clusters_networks (vcenter_id, cluster_id);
CREATE INDEX IF NOT EXISTS clusters_networks_vcenter_network_idx ON clusters_networks (vcenter_id, network_id);

CREATE TABLE IF NOT EXISTS vm_folders (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    datacenter_id  uuid        NOT NULL,
    path           text        NOT NULL,
    external_moref text,
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vm_folders_pkey PRIMARY KEY (id),
    CONSTRAINT vm_folders_datacenter_id_fkey
        FOREIGN KEY (datacenter_id) REFERENCES datacenters (id) ON DELETE RESTRICT,
    CONSTRAINT vm_folders_datacenter_path_uq UNIQUE (datacenter_id, path),
    CONSTRAINT vm_folders_datacenter_id_id_uq UNIQUE (datacenter_id, id)
);

-- ---------------------------------------------------------------------------
-- Business catalogs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operating_systems (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    family          text        NOT NULL,
    name            text        NOT NULL,
    version         text        NOT NULL DEFAULT '',
    vmware_guest_id text        NOT NULL DEFAULT '',
    is_active       boolean     NOT NULL DEFAULT true,
    created_by      uuid        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid,
    updated_at      timestamptz,
    CONSTRAINT operating_systems_pkey PRIMARY KEY (id),
    CONSTRAINT operating_systems_family_check CHECK (family IN ('windows', 'linux')),
    CONSTRAINT operating_systems_name_version_uq UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS vm_templates (
    id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
    vcenter_id          uuid        NOT NULL,
    operating_system_id uuid        NOT NULL,
    name                text        NOT NULL,
    content_library     text        NOT NULL DEFAULT '',
    os_disk_gb          integer,
    external_moref      text,
    is_active           boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vm_templates_pkey PRIMARY KEY (id),
    CONSTRAINT vm_templates_vcenter_id_fkey
        FOREIGN KEY (vcenter_id) REFERENCES vcenters (id) ON DELETE RESTRICT,
    CONSTRAINT vm_templates_operating_system_id_fkey
        FOREIGN KEY (operating_system_id) REFERENCES operating_systems (id) ON DELETE RESTRICT,
    CONSTRAINT vm_templates_os_disk_check CHECK (os_disk_gb IS NULL OR os_disk_gb > 0),
    CONSTRAINT vm_templates_vcenter_name_uq UNIQUE (vcenter_id, name),
    CONSTRAINT vm_templates_vcenter_id_id_uq UNIQUE (vcenter_id, id)
);
CREATE INDEX IF NOT EXISTS vm_templates_operating_system_id_idx ON vm_templates (operating_system_id);

CREATE TABLE IF NOT EXISTS software (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    company_id     uuid,
    name           text        NOT NULL,
    version        text        NOT NULL DEFAULT '',
    vendor         text        NOT NULL DEFAULT '',
    install_method text        NOT NULL DEFAULT 'script',
    install_ref    text        NOT NULL DEFAULT '',
    description    text        NOT NULL DEFAULT '',
    is_active      boolean     NOT NULL DEFAULT true,
    created_by     uuid        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    updated_at     timestamptz,
    CONSTRAINT software_pkey PRIMARY KEY (id),
    CONSTRAINT software_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT,
    CONSTRAINT software_install_method_check
        CHECK (install_method IN ('script', 'package', 'ansible', 'sccm', 'chocolatey', 'other'))
);
CREATE UNIQUE INDEX IF NOT EXISTS software_global_uq ON software (name, version) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS software_company_uq ON software (company_id, name, version) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS software_company_id_idx ON software (company_id);

-- Optional compatibility matrix: no rows for a software item = compatible with every OS.
CREATE TABLE IF NOT EXISTS operating_systems_software (
    operating_system_id uuid NOT NULL,
    software_id         uuid NOT NULL,
    CONSTRAINT operating_systems_software_pkey PRIMARY KEY (operating_system_id, software_id),
    CONSTRAINT operating_systems_software_os_fkey
        FOREIGN KEY (operating_system_id) REFERENCES operating_systems (id) ON DELETE CASCADE,
    CONSTRAINT operating_systems_software_software_fkey
        FOREIGN KEY (software_id) REFERENCES software (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS operating_systems_software_software_id_idx ON operating_systems_software (software_id);

CREATE TABLE IF NOT EXISTS vm_roles (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    company_id  uuid,
    name        text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    is_active   boolean     NOT NULL DEFAULT true,
    created_by  uuid        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    updated_at  timestamptz,
    CONSTRAINT vm_roles_pkey PRIMARY KEY (id),
    CONSTRAINT vm_roles_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS vm_roles_global_name_uq ON vm_roles (name) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vm_roles_company_name_uq ON vm_roles (company_id, name) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vm_roles_company_id_idx ON vm_roles (company_id);

CREATE TABLE IF NOT EXISTS vm_sizes (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    company_id       uuid,
    name             text        NOT NULL,
    vcpu             integer     NOT NULL,
    cores_per_socket integer     NOT NULL DEFAULT 1,
    ram_gb           integer     NOT NULL,
    is_active        boolean     NOT NULL DEFAULT true,
    created_by       uuid        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_by       uuid,
    updated_at       timestamptz,
    CONSTRAINT vm_sizes_pkey PRIMARY KEY (id),
    CONSTRAINT vm_sizes_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT,
    CONSTRAINT vm_sizes_vcpu_check CHECK (vcpu > 0),
    CONSTRAINT vm_sizes_cores_check CHECK (cores_per_socket > 0),
    CONSTRAINT vm_sizes_ram_check CHECK (ram_gb > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS vm_sizes_global_name_uq ON vm_sizes (name) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vm_sizes_company_name_uq ON vm_sizes (company_id, name) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vm_sizes_company_id_idx ON vm_sizes (company_id);

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vm_profiles (
    id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
    company_id          uuid,
    name                text        NOT NULL,
    description         text        NOT NULL DEFAULT '',
    status              text        NOT NULL DEFAULT 'draft',
    vm_role_id          uuid        NOT NULL,
    operating_system_id uuid        NOT NULL,
    vm_size_id          uuid        NOT NULL,
    vcpu_override       integer,
    ram_gb_override     integer,
    vcenter_id          uuid        NOT NULL,
    datacenter_id       uuid        NOT NULL,
    cluster_id          uuid        NOT NULL,
    resource_pool_id    uuid,
    vm_folder_id        uuid,
    vm_template_id      uuid,
    naming_pattern      text        NOT NULL DEFAULT '',
    -- Requester adjustments: extra data disks allowed on top of the profile's.
    max_extra_disks     integer     NOT NULL DEFAULT 0,
    max_extra_disk_gb   integer     NOT NULL DEFAULT 0,
    notes               text        NOT NULL DEFAULT '',
    created_by          uuid        NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          uuid,
    updated_at          timestamptz,
    CONSTRAINT vm_profiles_pkey PRIMARY KEY (id),
    CONSTRAINT vm_profiles_status_check CHECK (status IN ('draft', 'active', 'archived')),
    CONSTRAINT vm_profiles_vcpu_override_check CHECK (vcpu_override IS NULL OR vcpu_override > 0),
    CONSTRAINT vm_profiles_ram_override_check CHECK (ram_gb_override IS NULL OR ram_gb_override > 0),
    CONSTRAINT vm_profiles_extra_disks_check CHECK (max_extra_disks BETWEEN 0 AND 20 AND max_extra_disk_gb >= 0),
    CONSTRAINT vm_profiles_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT,
    CONSTRAINT vm_profiles_vm_role_id_fkey
        FOREIGN KEY (vm_role_id) REFERENCES vm_roles (id) ON DELETE RESTRICT,
    CONSTRAINT vm_profiles_operating_system_id_fkey
        FOREIGN KEY (operating_system_id) REFERENCES operating_systems (id) ON DELETE RESTRICT,
    CONSTRAINT vm_profiles_vm_size_id_fkey
        FOREIGN KEY (vm_size_id) REFERENCES vm_sizes (id) ON DELETE RESTRICT,
    -- Hierarchy integrity: cluster in vCenter, cluster in datacenter, pool in
    -- cluster, folder in datacenter, template on vCenter.
    CONSTRAINT vm_profiles_cluster_fkey
        FOREIGN KEY (vcenter_id, cluster_id) REFERENCES clusters (vcenter_id, id) ON DELETE RESTRICT,
    CONSTRAINT vm_profiles_cluster_datacenter_fkey
        FOREIGN KEY (cluster_id, datacenter_id) REFERENCES clusters (id, datacenter_id) ON DELETE RESTRICT,
    CONSTRAINT vm_profiles_resource_pool_fkey
        FOREIGN KEY (cluster_id, resource_pool_id) REFERENCES resource_pools (cluster_id, id) ON DELETE RESTRICT,
    CONSTRAINT vm_profiles_vm_folder_fkey
        FOREIGN KEY (datacenter_id, vm_folder_id) REFERENCES vm_folders (datacenter_id, id) ON DELETE RESTRICT,
    CONSTRAINT vm_profiles_vm_template_fkey
        FOREIGN KEY (vcenter_id, vm_template_id) REFERENCES vm_templates (vcenter_id, id) ON DELETE RESTRICT,
    CONSTRAINT vm_profiles_id_cluster_id_uq UNIQUE (id, cluster_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS vm_profiles_global_name_uq ON vm_profiles (name) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vm_profiles_company_name_uq ON vm_profiles (company_id, name) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vm_profiles_company_id_idx ON vm_profiles (company_id);
CREATE INDEX IF NOT EXISTS vm_profiles_vm_role_id_idx ON vm_profiles (vm_role_id);
CREATE INDEX IF NOT EXISTS vm_profiles_operating_system_id_idx ON vm_profiles (operating_system_id);
CREATE INDEX IF NOT EXISTS vm_profiles_vm_size_id_idx ON vm_profiles (vm_size_id);
CREATE INDEX IF NOT EXISTS vm_profiles_vcenter_cluster_idx ON vm_profiles (vcenter_id, cluster_id);
CREATE INDEX IF NOT EXISTS vm_profiles_cluster_datacenter_idx ON vm_profiles (cluster_id, datacenter_id);
CREATE INDEX IF NOT EXISTS vm_profiles_cluster_pool_idx ON vm_profiles (cluster_id, resource_pool_id);
CREATE INDEX IF NOT EXISTS vm_profiles_datacenter_folder_idx ON vm_profiles (datacenter_id, vm_folder_id);
CREATE INDEX IF NOT EXISTS vm_profiles_vcenter_template_idx ON vm_profiles (vcenter_id, vm_template_id);

-- cluster_id is copied from the profile so the datastore FK can require the
-- datastore to be attached to the profile's cluster. The API rewrites disks
-- and NICs on every profile save (delete, update profile, insert).
CREATE TABLE IF NOT EXISTS vm_profile_disks (
    id            uuid    NOT NULL DEFAULT gen_random_uuid(),
    vm_profile_id uuid    NOT NULL,
    cluster_id    uuid    NOT NULL,
    disk_order    integer NOT NULL,
    label         text    NOT NULL DEFAULT '',
    size_gb       integer NOT NULL,
    mount_point   text    NOT NULL,
    filesystem    text    NOT NULL DEFAULT '',
    provisioning  text    NOT NULL DEFAULT 'thin',
    datastore_id  uuid,
    CONSTRAINT vm_profile_disks_pkey PRIMARY KEY (id),
    CONSTRAINT vm_profile_disks_profile_fkey
        FOREIGN KEY (vm_profile_id, cluster_id) REFERENCES vm_profiles (id, cluster_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT vm_profile_disks_datastore_fkey
        FOREIGN KEY (cluster_id, datastore_id) REFERENCES clusters_datastores (cluster_id, datastore_id) ON DELETE RESTRICT,
    CONSTRAINT vm_profile_disks_size_check CHECK (size_gb > 0),
    CONSTRAINT vm_profile_disks_order_check CHECK (disk_order >= 0),
    CONSTRAINT vm_profile_disks_provisioning_check
        CHECK (provisioning IN ('thin', 'thick_lazy', 'thick_eager')),
    CONSTRAINT vm_profile_disks_order_uq UNIQUE (vm_profile_id, disk_order),
    CONSTRAINT vm_profile_disks_mount_uq UNIQUE (vm_profile_id, mount_point)
);
CREATE INDEX IF NOT EXISTS vm_profile_disks_profile_cluster_idx ON vm_profile_disks (vm_profile_id, cluster_id);
CREATE INDEX IF NOT EXISTS vm_profile_disks_cluster_datastore_idx ON vm_profile_disks (cluster_id, datastore_id);

CREATE TABLE IF NOT EXISTS vm_profile_nics (
    id            uuid    NOT NULL DEFAULT gen_random_uuid(),
    vm_profile_id uuid    NOT NULL,
    cluster_id    uuid    NOT NULL,
    nic_order     integer NOT NULL,
    network_id    uuid    NOT NULL,
    adapter_type  text    NOT NULL DEFAULT 'vmxnet3',
    CONSTRAINT vm_profile_nics_pkey PRIMARY KEY (id),
    CONSTRAINT vm_profile_nics_profile_fkey
        FOREIGN KEY (vm_profile_id, cluster_id) REFERENCES vm_profiles (id, cluster_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT vm_profile_nics_network_fkey
        FOREIGN KEY (cluster_id, network_id) REFERENCES clusters_networks (cluster_id, network_id) ON DELETE RESTRICT,
    CONSTRAINT vm_profile_nics_order_check CHECK (nic_order >= 0),
    CONSTRAINT vm_profile_nics_adapter_check CHECK (adapter_type IN ('vmxnet3', 'e1000e')),
    CONSTRAINT vm_profile_nics_order_uq UNIQUE (vm_profile_id, nic_order)
);
CREATE INDEX IF NOT EXISTS vm_profile_nics_profile_cluster_idx ON vm_profile_nics (vm_profile_id, cluster_id);
CREATE INDEX IF NOT EXISTS vm_profile_nics_cluster_network_idx ON vm_profile_nics (cluster_id, network_id);

-- Networks a requester may pick instead of the NIC's default (all attached
-- to the profile's cluster). Rewritten with the NICs on every profile save.
CREATE TABLE IF NOT EXISTS vm_profile_nic_options (
    vm_profile_id uuid    NOT NULL,
    cluster_id    uuid    NOT NULL,
    nic_order     integer NOT NULL,
    network_id    uuid    NOT NULL,
    CONSTRAINT vm_profile_nic_options_pkey PRIMARY KEY (vm_profile_id, nic_order, network_id),
    CONSTRAINT vm_profile_nic_options_profile_fkey
        FOREIGN KEY (vm_profile_id, cluster_id) REFERENCES vm_profiles (id, cluster_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT vm_profile_nic_options_network_fkey
        FOREIGN KEY (cluster_id, network_id) REFERENCES clusters_networks (cluster_id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS vm_profile_nic_options_profile_cluster_idx ON vm_profile_nic_options (vm_profile_id, cluster_id);
CREATE INDEX IF NOT EXISTS vm_profile_nic_options_cluster_network_idx ON vm_profile_nic_options (cluster_id, network_id);

CREATE TABLE IF NOT EXISTS vm_profiles_software (
    vm_profile_id uuid    NOT NULL,
    software_id   uuid    NOT NULL,
    install_order integer NOT NULL DEFAULT 0,
    is_mandatory  boolean NOT NULL DEFAULT true,
    CONSTRAINT vm_profiles_software_pkey PRIMARY KEY (vm_profile_id, software_id),
    CONSTRAINT vm_profiles_software_profile_fkey
        FOREIGN KEY (vm_profile_id) REFERENCES vm_profiles (id) ON DELETE CASCADE,
    CONSTRAINT vm_profiles_software_software_fkey
        FOREIGN KEY (software_id) REFERENCES software (id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS vm_profiles_software_software_id_idx ON vm_profiles_software (software_id);

-- Size presets a requester may switch to (the profile's own size is always allowed).
CREATE TABLE IF NOT EXISTS vm_profiles_allowed_sizes (
    vm_profile_id uuid NOT NULL,
    vm_size_id    uuid NOT NULL,
    CONSTRAINT vm_profiles_allowed_sizes_pkey PRIMARY KEY (vm_profile_id, vm_size_id),
    CONSTRAINT vm_profiles_allowed_sizes_profile_fkey
        FOREIGN KEY (vm_profile_id) REFERENCES vm_profiles (id) ON DELETE CASCADE,
    CONSTRAINT vm_profiles_allowed_sizes_size_fkey
        FOREIGN KEY (vm_size_id) REFERENCES vm_sizes (id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS vm_profiles_allowed_sizes_size_idx ON vm_profiles_allowed_sizes (vm_size_id);

-- ---------------------------------------------------------------------------
-- Provisioning requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vm_requests (
    id                uuid        NOT NULL DEFAULT gen_random_uuid(),
    company_id        uuid        NOT NULL,
    vm_profile_id     uuid        NOT NULL,
    hostname          text        NOT NULL,
    quantity          integer     NOT NULL DEFAULT 1,
    justification     text        NOT NULL DEFAULT '',
    status            text        NOT NULL DEFAULT 'submitted',
    status_reason     text        NOT NULL DEFAULT '',
    spec              jsonb       NOT NULL,
    requested_by      uuid        NOT NULL,
    requested_by_name text        NOT NULL DEFAULT '',
    real_requested_by uuid        NOT NULL,
    submitted_at      timestamptz,
    decided_by        uuid,
    decided_by_name   text        NOT NULL DEFAULT '',
    decided_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz,
    CONSTRAINT vm_requests_pkey PRIMARY KEY (id),
    CONSTRAINT vm_requests_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT,
    CONSTRAINT vm_requests_vm_profile_id_fkey
        FOREIGN KEY (vm_profile_id) REFERENCES vm_profiles (id) ON DELETE RESTRICT,
    CONSTRAINT vm_requests_quantity_check CHECK (quantity BETWEEN 1 AND 50),
    CONSTRAINT vm_requests_status_check CHECK (status IN
        ('draft', 'submitted', 'approved', 'rejected', 'provisioning', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS vm_requests_company_status_idx ON vm_requests (company_id, status);
CREATE INDEX IF NOT EXISTS vm_requests_vm_profile_id_idx ON vm_requests (vm_profile_id);
CREATE INDEX IF NOT EXISTS vm_requests_requested_by_idx ON vm_requests (requested_by);

CREATE TABLE IF NOT EXISTS vm_request_events (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    vm_request_id uuid        NOT NULL,
    from_status   text        NOT NULL DEFAULT '',
    to_status     text        NOT NULL,
    user_id       uuid        NOT NULL,
    user_name     text        NOT NULL DEFAULT '',
    comment       text        NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vm_request_events_pkey PRIMARY KEY (id),
    CONSTRAINT vm_request_events_request_fkey
        FOREIGN KEY (vm_request_id) REFERENCES vm_requests (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS vm_request_events_vm_request_id_idx ON vm_request_events (vm_request_id, created_at);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
    id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
    entity_type        text        NOT NULL,
    entity_id          uuid,
    action             text        NOT NULL,
    company_id         uuid,
    summary            text        NOT NULL DEFAULT '',
    diff               jsonb       NOT NULL DEFAULT '{}'::jsonb,
    user_id            uuid        NOT NULL,
    user_name          text        NOT NULL DEFAULT '',
    real_user_id       uuid        NOT NULL,
    user_impersonation boolean     NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_events_pkey PRIMARY KEY (id),
    CONSTRAINT audit_events_action_check
        CHECK (action IN ('create', 'update', 'archive', 'restore', 'delete', 'attach', 'detach',
                          'submit', 'approve', 'reject', 'grant', 'revoke', 'sync'))
);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_events_company_id_idx ON audit_events (company_id);

-- ---------------------------------------------------------------------------
-- Inventory syncs (external feeds of vCenter infrastructure)
-- ---------------------------------------------------------------------------
-- One row per accepted PUT /inventory/vcenter call (applied or dry run).
-- Failed calls roll back entirely and leave no row.
CREATE TABLE IF NOT EXISTS inventory_syncs (
    id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
    vcenter_id         uuid,
    vcenter_fqdn       text        NOT NULL,
    source             text        NOT NULL DEFAULT '',
    dry_run            boolean     NOT NULL DEFAULT false,
    prune              boolean     NOT NULL DEFAULT true,
    summary            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    warnings           jsonb       NOT NULL DEFAULT '[]'::jsonb,
    change_count       integer     NOT NULL DEFAULT 0,
    user_id            uuid        NOT NULL,
    user_name          text        NOT NULL DEFAULT '',
    real_user_id       uuid        NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inventory_syncs_pkey PRIMARY KEY (id),
    CONSTRAINT inventory_syncs_vcenter_id_fkey
        FOREIGN KEY (vcenter_id) REFERENCES vcenters (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS inventory_syncs_vcenter_created_idx ON inventory_syncs (vcenter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_syncs_created_idx ON inventory_syncs (created_at DESC);

-- ---------------------------------------------------------------------------
-- IP allocations (static addressing from a network's pool)
-- ---------------------------------------------------------------------------
-- kind 'request': assigned to a VM of an approved request.
-- kind 'reserved': used outside this app; an admin blocks it from the pool.
CREATE TABLE IF NOT EXISTS ip_allocations (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    network_id    uuid        NOT NULL,
    ip            inet        NOT NULL,
    kind          text        NOT NULL,
    vm_request_id uuid,
    hostname      text        NOT NULL DEFAULT '',
    nic_order     integer,
    note          text        NOT NULL DEFAULT '',
    created_by    uuid        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ip_allocations_pkey PRIMARY KEY (id),
    CONSTRAINT ip_allocations_network_fkey
        FOREIGN KEY (network_id) REFERENCES networks (id) ON DELETE RESTRICT,
    CONSTRAINT ip_allocations_request_fkey
        FOREIGN KEY (vm_request_id) REFERENCES vm_requests (id) ON DELETE CASCADE,
    CONSTRAINT ip_allocations_kind_check CHECK (kind IN ('request', 'reserved')),
    CONSTRAINT ip_allocations_request_kind_check CHECK ((kind = 'request') = (vm_request_id IS NOT NULL)),
    CONSTRAINT ip_allocations_network_ip_uq UNIQUE (network_id, ip)
);
CREATE INDEX IF NOT EXISTS ip_allocations_request_idx ON ip_allocations (vm_request_id);
