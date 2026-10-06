"""VM profiles: create / edit / clone / status / delete, plus the fully
resolved ("expanded") profile used by the provisioning form and frozen into
requests.

Integrity is split between:
  - the database (composite FKs: pool in cluster, datastore attached to the
    cluster, folder in the cluster's datacenter, template on the vCenter)
  - `_validate` here (scope rules + friendlier messages for the FK cases)
"""

from typing import Any, Literal
from uuid import UUID

import asyncpg
from asyncpg.exceptions import CheckViolationError, ForeignKeyViolationError, UniqueViolationError
from fastapi import Depends
from pydantic import BaseModel, Field

from nttdsp.web import Conflict, Invalid, NotFound, SecuredRouter, db, secured

from access import Access, audit, ensure_ref_scope, get_access, parse_scope, visibility_sql
from crud import db_errors

router = SecuredRouter(prefix="/profiles")


class DiskIn(BaseModel):
    disk_order: int = Field(..., ge=0, le=63)
    label: str = Field("", max_length=80)
    size_gb: int = Field(..., ge=1, le=65536)
    mount_point: str = Field(..., min_length=1, max_length=200)
    filesystem: str = Field("", max_length=20)
    provisioning: Literal["thin", "thick_lazy", "thick_eager"] = "thin"
    datastore_id: UUID | None = None


class NicIn(BaseModel):
    nic_order: int = Field(..., ge=0, le=9)
    network_id: UUID
    adapter_type: Literal["vmxnet3", "e1000e"] = "vmxnet3"


class SoftwareItemIn(BaseModel):
    software_id: UUID
    install_order: int = Field(0, ge=0, le=999)
    is_mandatory: bool = True


class ProfileIn(BaseModel):
    company_id: UUID | None = None
    name: str = Field(..., min_length=1, max_length=120)
    description: str = Field("", max_length=1000)
    status: Literal["draft", "active"] = "draft"
    vm_role_id: UUID
    operating_system_id: UUID
    vm_size_id: UUID
    vcpu_override: int | None = Field(None, ge=1, le=256)
    ram_gb_override: int | None = Field(None, ge=1, le=12288)
    vcenter_id: UUID
    cluster_id: UUID
    resource_pool_id: UUID | None = None
    vm_folder_id: UUID | None = None
    vm_template_id: UUID | None = None
    naming_pattern: str = Field("", max_length=120)
    notes: str = Field("", max_length=2000)
    disks: list[DiskIn] = Field(..., min_length=1, max_length=60)
    nics: list[NicIn] = Field(..., min_length=1, max_length=10)
    software: list[SoftwareItemIn] = Field(default_factory=list, max_length=200)


class CloneIn(BaseModel):
    company_id: UUID | None = None
    name: str = Field(..., min_length=1, max_length=120)


class StatusIn(BaseModel):
    status: Literal["draft", "active", "archived"]


# Column order used by the literal INSERT / UPDATE / SELECT statements below.
PROFILE_COLS = [
    "company_id", "name", "description", "status", "vm_role_id", "operating_system_id", "vm_size_id",
    "vcpu_override", "ram_gb_override", "vcenter_id", "datacenter_id", "cluster_id", "resource_pool_id",
    "vm_folder_id", "vm_template_id", "naming_pattern", "notes",
]


# ---------------------------------------------------------------------------
# Validation + persistence
# ---------------------------------------------------------------------------

_REF_COMPANY_SQL = {
    "vm_roles": "SELECT company_id FROM vm_roles WHERE id = $1",
    "vm_sizes": "SELECT company_id FROM vm_sizes WHERE id = $1",
    "vcenters": "SELECT company_id FROM vcenters WHERE id = $1",
}


async def _ref_company(conn: asyncpg.Connection, table: str, ref_id: UUID, what: str) -> UUID | None:
    row = await conn.fetchrow(_REF_COMPANY_SQL[table], ref_id)
    if row is None:
        raise Invalid(f"{what} does not exist")
    return row["company_id"]


async def _validate(conn: asyncpg.Connection, body: ProfileIn, company: UUID | None) -> UUID:
    """Checks scope rules and hierarchy; returns the cluster's datacenter_id."""
    ensure_ref_scope(company, await _ref_company(conn, "vm_roles", body.vm_role_id, "role"), "roles")
    ensure_ref_scope(company, await _ref_company(conn, "vm_sizes", body.vm_size_id, "size"), "sizes")
    ensure_ref_scope(company, await _ref_company(conn, "vcenters", body.vcenter_id, "vCenter"), "vCenters")
    if not await conn.fetchval("SELECT 1 FROM operating_systems WHERE id = $1", body.operating_system_id):
        raise Invalid("operating system does not exist")

    cluster = await conn.fetchrow("SELECT vcenter_id, datacenter_id FROM clusters WHERE id = $1", body.cluster_id)
    if cluster is None or cluster["vcenter_id"] != body.vcenter_id:
        raise Invalid("the cluster does not belong to the selected vCenter")
    if body.resource_pool_id and not await conn.fetchval(
        "SELECT 1 FROM resource_pools WHERE id = $1 AND cluster_id = $2", body.resource_pool_id, body.cluster_id
    ):
        raise Invalid("the resource pool does not belong to the selected cluster")
    if body.vm_folder_id and not await conn.fetchval(
        "SELECT 1 FROM vm_folders WHERE id = $1 AND datacenter_id = $2", body.vm_folder_id, cluster["datacenter_id"]
    ):
        raise Invalid("the folder does not belong to the cluster's datacenter")
    if body.vm_template_id:
        tpl = await conn.fetchrow(
            "SELECT vcenter_id, operating_system_id FROM vm_templates WHERE id = $1", body.vm_template_id
        )
        if tpl is None or tpl["vcenter_id"] != body.vcenter_id:
            raise Invalid("the template is not on the selected vCenter")
        if tpl["operating_system_id"] != body.operating_system_id:
            raise Invalid("the template's operating system does not match the profile's")

    orders = [d.disk_order for d in body.disks]
    mounts = [d.mount_point.strip().lower() for d in body.disks]
    if len(set(orders)) != len(orders) or len(set(mounts)) != len(mounts):
        raise Invalid("disk order and mount point must be unique per profile")
    if len({n.nic_order for n in body.nics}) != len(body.nics):
        raise Invalid("NIC order must be unique per profile")

    ds_ids = {d.datastore_id for d in body.disks if d.datastore_id}
    if ds_ids:
        n = await conn.fetchval(
            "SELECT count(*) FROM clusters_datastores WHERE cluster_id = $1 AND datastore_id = ANY($2::uuid[])",
            body.cluster_id, list(ds_ids),
        )
        if n != len(ds_ids):
            raise Invalid("every disk datastore must be attached to the selected cluster")
    net_ids = {n.network_id for n in body.nics}
    n = await conn.fetchval(
        "SELECT count(*) FROM clusters_networks WHERE cluster_id = $1 AND network_id = ANY($2::uuid[])",
        body.cluster_id, list(net_ids),
    )
    if n != len(net_ids):
        raise Invalid("every network must be attached to the selected cluster")

    sw_ids = [s.software_id for s in body.software]
    if len(set(sw_ids)) != len(sw_ids):
        raise Invalid("software can only be added once per profile")
    if sw_ids:
        rows = await conn.fetch(
            "SELECT s.id, s.name, s.company_id, "
            "EXISTS (SELECT 1 FROM operating_systems_software x WHERE x.software_id = s.id) AS restricted, "
            "EXISTS (SELECT 1 FROM operating_systems_software x WHERE x.software_id = s.id "
            "        AND x.operating_system_id = $2) AS compatible "
            "FROM software s WHERE s.id = ANY($1::uuid[])",
            sw_ids, body.operating_system_id,
        )
        if len(rows) != len(sw_ids):
            raise Invalid("software does not exist")
        for r in rows:
            ensure_ref_scope(company, r["company_id"], "software")
            if r["restricted"] and not r["compatible"]:
                raise Invalid(f"{r['name']} is not compatible with the selected operating system")
    return cluster["datacenter_id"]


async def _write_children(conn: asyncpg.Connection, profile_id: UUID, body: ProfileIn) -> None:
    await conn.executemany(
        "INSERT INTO vm_profile_disks (vm_profile_id, cluster_id, disk_order, label, size_gb, mount_point, "
        "filesystem, provisioning, datastore_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [(profile_id, body.cluster_id, d.disk_order, d.label, d.size_gb, d.mount_point.strip(), d.filesystem,
          d.provisioning, d.datastore_id) for d in body.disks],
    )
    await conn.executemany(
        "INSERT INTO vm_profile_nics (vm_profile_id, cluster_id, nic_order, network_id, adapter_type) "
        "VALUES ($1, $2, $3, $4, $5)",
        [(profile_id, body.cluster_id, n.nic_order, n.network_id, n.adapter_type) for n in body.nics],
    )
    if body.software:
        await conn.executemany(
            "INSERT INTO vm_profiles_software (vm_profile_id, software_id, install_order, is_mandatory) "
            "VALUES ($1, $2, $3, $4)",
            [(profile_id, s.software_id, s.install_order, s.is_mandatory) for s in body.software],
        )


async def _insert(conn: asyncpg.Connection, acc: Access, body: ProfileIn, company: UUID | None) -> UUID:
    acc.ensure_manage(company)
    data = body.model_dump(exclude={"disks", "nics", "software"})
    data["company_id"] = company
    data["datacenter_id"] = await _validate(conn, body, company)
    try:
        profile_id = await conn.fetchval(
            "INSERT INTO vm_profiles (company_id, name, description, status, vm_role_id, operating_system_id, "
            "vm_size_id, vcpu_override, ram_gb_override, vcenter_id, datacenter_id, cluster_id, resource_pool_id, "
            "vm_folder_id, vm_template_id, naming_pattern, notes, created_by) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id",
            *[data[c] for c in PROFILE_COLS], acc.user_id,
        )
        await _write_children(conn, profile_id, body)
    except (UniqueViolationError, ForeignKeyViolationError, CheckViolationError) as exc:
        raise db_errors(exc) from exc
    await audit(conn, acc, entity_type="vm_profile", entity_id=profile_id, action="create",
                company_id=company, summary=body.name, diff=body.model_dump(mode="json"))
    return profile_id


async def _company_of(conn: asyncpg.Connection, profile_id: UUID) -> tuple[UUID | None, str]:
    row = await conn.fetchrow("SELECT company_id, status FROM vm_profiles WHERE id = $1", profile_id)
    if row is None:
        raise NotFound("profile not found")
    return row["company_id"], row["status"]


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

_LIST_SQL = """
SELECT p.id, p.name, p.description, p.status, p.company_id, co.name AS company_name,
       r.name AS role_name, o.family AS os_family, o.name || ' ' || o.version AS os_name,
       z.name AS size_name, COALESCE(p.vcpu_override, z.vcpu) AS vcpu,
       COALESCE(p.ram_gb_override, z.ram_gb) AS ram_gb,
       v.name AS vcenter_name, c.name AS cluster_name,
       (SELECT COALESCE(sum(d.size_gb), 0) FROM vm_profile_disks d WHERE d.vm_profile_id = p.id) AS disk_total_gb,
       (SELECT count(*) FROM vm_profile_disks d WHERE d.vm_profile_id = p.id) AS disk_count,
       (SELECT count(*) FROM vm_profiles_software s WHERE s.vm_profile_id = p.id) AS software_count,
       COALESCE(p.updated_at, p.created_at) AS updated_at
FROM vm_profiles p
LEFT JOIN companies co ON co.id = p.company_id
JOIN vm_roles r ON r.id = p.vm_role_id
JOIN operating_systems o ON o.id = p.operating_system_id
JOIN vm_sizes z ON z.id = p.vm_size_id
JOIN vcenters v ON v.id = p.vcenter_id
JOIN clusters c ON c.id = p.cluster_id
"""


@router.get("")
@secured(requires=["permission:member"], db_access="read")
async def list_profiles(
    scope: str | None = None,
    status: str | None = None,
    for_company: UUID | None = None,
    conn: asyncpg.Connection = Depends(db),
    acc: Access = Depends(get_access),
) -> list[dict[str, Any]]:
    """`scope` filters the admin list; `for_company` returns the *effective*
    set for one company (global + that company's, active only) — the list the
    provisioning form offers."""
    args: list[Any] = []
    if for_company is not None:
        acc.ensure_view(for_company)
        where = [visibility_sql(acc, "p.company_id", for_company, args, effective=True), "p.status = 'active'"]
    else:
        where = [visibility_sql(acc, "p.company_id", parse_scope(scope), args)]
        if status in ("draft", "active", "archived"):
            args.append(status)
            where.append(f"p.status = ${len(args)}")
        elif status != "any":
            where.append("p.status <> 'archived'")
    rows = await conn.fetch(f"{_LIST_SQL} WHERE {' AND '.join(where)} ORDER BY p.name", *args)
    return [dict(r) for r in rows]


@router.get("/{profile_id}")
@secured(requires=["permission:member"], db_access="read")
async def get_profile(
    profile_id: UUID, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    """Editable shape (ProfileIn + id, company name, status, request count)."""
    return await _load_editable(conn, acc, profile_id)


async def _load_editable(conn: asyncpg.Connection, acc: Access, profile_id: UUID) -> dict[str, Any]:
    row = await conn.fetchrow(
        "SELECT p.id, p.company_id, p.name, p.description, p.status, p.vm_role_id, p.operating_system_id, "
        "p.vm_size_id, p.vcpu_override, p.ram_gb_override, p.vcenter_id, p.datacenter_id, p.cluster_id, "
        "p.resource_pool_id, p.vm_folder_id, p.vm_template_id, p.naming_pattern, p.notes, co.name AS company_name, "
        "(SELECT count(*) FROM vm_requests q WHERE q.vm_profile_id = p.id) AS request_count, "
        "p.created_at, p.updated_at FROM vm_profiles p LEFT JOIN companies co ON co.id = p.company_id "
        "WHERE p.id = $1",
        profile_id,
    )
    if row is None:
        raise NotFound("profile not found")
    acc.ensure_view(row["company_id"])
    out = dict(row)
    out["disks"] = [dict(r) for r in await conn.fetch(
        "SELECT disk_order, label, size_gb, mount_point, filesystem, provisioning, datastore_id "
        "FROM vm_profile_disks WHERE vm_profile_id = $1 ORDER BY disk_order", profile_id)]
    out["nics"] = [dict(r) for r in await conn.fetch(
        "SELECT nic_order, network_id, adapter_type FROM vm_profile_nics WHERE vm_profile_id = $1 "
        "ORDER BY nic_order", profile_id)]
    out["software"] = [dict(r) for r in await conn.fetch(
        "SELECT software_id, install_order, is_mandatory FROM vm_profiles_software WHERE vm_profile_id = $1 "
        "ORDER BY install_order", profile_id)]
    return out


async def expand_profile(conn: asyncpg.Connection, profile_id: UUID) -> dict[str, Any]:
    """Fully resolved, self-contained spec. Also the input for a future
    provisioning job, so it carries ids, names and VMware identifiers."""
    p = await conn.fetchrow(
        """
        SELECT p.id, p.name, p.description, p.status, p.company_id, co.name AS company_name,
               p.naming_pattern, p.notes, p.vcpu_override, p.ram_gb_override,
               r.id AS role_id, r.name AS role_name, r.is_active AS role_active,
               o.id AS os_id, o.family AS os_family, o.name AS os_name, o.version AS os_version,
               o.vmware_guest_id, o.is_active AS os_active,
               z.id AS size_id, z.name AS size_name, z.vcpu, z.cores_per_socket, z.ram_gb, z.is_active AS size_active,
               v.id AS vcenter_id, v.name AS vcenter_name, v.fqdn AS vcenter_fqdn,
               v.credential_secret_name, v.is_active AS vcenter_active,
               dc.id AS datacenter_id, dc.name AS datacenter_name,
               c.id AS cluster_id, c.name AS cluster_name, c.is_active AS cluster_active,
               rp.id AS pool_id, rp.name AS pool_name, rp.path AS pool_path, rp.is_active AS pool_active,
               f.id AS folder_id, f.path AS folder_path,
               t.id AS template_id, t.name AS template_name, t.content_library, t.is_active AS template_active
        FROM vm_profiles p
        LEFT JOIN companies co ON co.id = p.company_id
        JOIN vm_roles r ON r.id = p.vm_role_id
        JOIN operating_systems o ON o.id = p.operating_system_id
        JOIN vm_sizes z ON z.id = p.vm_size_id
        JOIN vcenters v ON v.id = p.vcenter_id
        JOIN datacenters dc ON dc.id = p.datacenter_id
        JOIN clusters c ON c.id = p.cluster_id
        LEFT JOIN resource_pools rp ON rp.id = p.resource_pool_id
        LEFT JOIN vm_folders f ON f.id = p.vm_folder_id
        LEFT JOIN vm_templates t ON t.id = p.vm_template_id
        WHERE p.id = $1
        """,
        profile_id,
    )
    if p is None:
        raise NotFound("profile not found")
    disks = await conn.fetch(
        "SELECT d.disk_order, d.label, d.size_gb, d.mount_point, d.filesystem, d.provisioning, "
        "ds.id AS datastore_id, ds.name AS datastore_name, ds.is_active AS datastore_active "
        "FROM vm_profile_disks d LEFT JOIN datastores ds ON ds.id = d.datastore_id "
        "WHERE d.vm_profile_id = $1 ORDER BY d.disk_order", profile_id)
    nics = await conn.fetch(
        "SELECT n.nic_order, n.adapter_type, w.id AS network_id, w.name AS network_name, w.vlan_id, "
        "w.type AS network_type, w.is_active AS network_active "
        "FROM vm_profile_nics n JOIN networks w ON w.id = n.network_id "
        "WHERE n.vm_profile_id = $1 ORDER BY n.nic_order", profile_id)
    software = await conn.fetch(
        "SELECT s.id, s.name, s.version, s.vendor, s.install_method, s.install_ref, s.is_active, "
        "s.company_id IS NULL AS is_global, ps.install_order, ps.is_mandatory "
        "FROM vm_profiles_software ps JOIN software s ON s.id = ps.software_id "
        "WHERE ps.vm_profile_id = $1 ORDER BY ps.install_order, s.name", profile_id)

    warnings = [label for label, ok in [
        ("role", p["role_active"]), ("operating system", p["os_active"]), ("size", p["size_active"]),
        ("vCenter", p["vcenter_active"]), ("cluster", p["cluster_active"]),
        ("resource pool", p["pool_active"] is not False), ("template", p["template_active"] is not False),
    ] if not ok]
    warnings += [f"datastore {d['datastore_name']}" for d in disks if d["datastore_active"] is False]
    warnings += [f"network {n['network_name']}" for n in nics if not n["network_active"]]
    warnings += [f"software {s['name']}" for s in software if not s["is_active"]]

    def ref(i: Any, **kw: Any) -> dict[str, Any] | None:
        return {"id": i, **kw} if i is not None else None

    return {
        "id": p["id"], "name": p["name"], "description": p["description"], "status": p["status"],
        "company": ref(p["company_id"], name=p["company_name"]),
        "role": ref(p["role_id"], name=p["role_name"]),
        "operating_system": ref(p["os_id"], family=p["os_family"], name=p["os_name"], version=p["os_version"],
                                vmware_guest_id=p["vmware_guest_id"]),
        "compute": {
            "size": ref(p["size_id"], name=p["size_name"]),
            "vcpu": p["vcpu_override"] or p["vcpu"],
            "cores_per_socket": p["cores_per_socket"],
            "ram_gb": p["ram_gb_override"] or p["ram_gb"],
            "overridden": p["vcpu_override"] is not None or p["ram_gb_override"] is not None,
        },
        "placement": {
            "vcenter": ref(p["vcenter_id"], name=p["vcenter_name"], fqdn=p["vcenter_fqdn"],
                           credential_secret_name=p["credential_secret_name"]),
            "datacenter": ref(p["datacenter_id"], name=p["datacenter_name"]),
            "cluster": ref(p["cluster_id"], name=p["cluster_name"]),
            "resource_pool": ref(p["pool_id"], name=p["pool_name"], path=p["pool_path"]),
            "folder": ref(p["folder_id"], path=p["folder_path"]),
            "template": ref(p["template_id"], name=p["template_name"], content_library=p["content_library"]),
        },
        "disks": [{
            "disk_order": d["disk_order"], "label": d["label"], "size_gb": d["size_gb"],
            "mount_point": d["mount_point"], "filesystem": d["filesystem"], "provisioning": d["provisioning"],
            "datastore": ref(d["datastore_id"], name=d["datastore_name"]),
        } for d in disks],
        "disk_total_gb": sum(d["size_gb"] for d in disks),
        "nics": [{
            "nic_order": n["nic_order"], "adapter_type": n["adapter_type"],
            "network": ref(n["network_id"], name=n["network_name"], vlan_id=n["vlan_id"], type=n["network_type"]),
        } for n in nics],
        "software": [{
            "id": s["id"], "name": s["name"], "version": s["version"], "vendor": s["vendor"],
            "install_method": s["install_method"], "install_ref": s["install_ref"],
            "install_order": s["install_order"], "is_mandatory": s["is_mandatory"],
            "scope": "global" if s["is_global"] else "company",
        } for s in software],
        "naming_pattern": p["naming_pattern"],
        "notes": p["notes"],
        "warnings": warnings,
    }


@router.get("/{profile_id}/expanded")
@secured(requires=["permission:member"], db_access="read")
async def get_expanded(
    profile_id: UUID, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    company, _ = await _company_of(conn, profile_id)
    acc.ensure_view(company)
    return await expand_profile(conn, profile_id)


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------

@router.post("", status_code=201)
@secured(requires=["permission:admin"], db_access="write")
async def create_profile(
    body: ProfileIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    profile_id = await _insert(conn, acc, body, body.company_id)
    return {"id": profile_id}


@router.put("/{profile_id}")
@secured(requires=["permission:admin"], db_access="write")
async def update_profile(
    profile_id: UUID, body: ProfileIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    company, current_status = await _company_of(conn, profile_id)
    acc.ensure_manage(company)  # scope (company_id) is immutable: clone to move a profile
    datacenter_id = await _validate(conn, body, company)
    data = body.model_dump(exclude={"disks", "nics", "software", "company_id"})
    data["datacenter_id"] = datacenter_id
    if current_status == "archived":
        data["status"] = "archived"
    cols = [c for c in PROFILE_COLS if c != "company_id"]
    try:
        # Children first: their cluster_id must follow the profile's.
        await conn.execute("DELETE FROM vm_profile_disks WHERE vm_profile_id = $1", profile_id)
        await conn.execute("DELETE FROM vm_profile_nics WHERE vm_profile_id = $1", profile_id)
        await conn.execute("DELETE FROM vm_profiles_software WHERE vm_profile_id = $1", profile_id)
        await conn.execute(
            "UPDATE vm_profiles SET name = $2, description = $3, status = $4, vm_role_id = $5, "
            "operating_system_id = $6, vm_size_id = $7, vcpu_override = $8, ram_gb_override = $9, "
            "vcenter_id = $10, datacenter_id = $11, cluster_id = $12, resource_pool_id = $13, "
            "vm_folder_id = $14, vm_template_id = $15, naming_pattern = $16, notes = $17, "
            "updated_by = $18, updated_at = now() WHERE id = $1",
            profile_id, *[data[c] for c in cols], acc.user_id,
        )
        await _write_children(conn, profile_id, body)
    except (UniqueViolationError, ForeignKeyViolationError, CheckViolationError) as exc:
        raise db_errors(exc) from exc
    await audit(conn, acc, entity_type="vm_profile", entity_id=profile_id, action="update",
                company_id=company, summary=body.name, diff=body.model_dump(mode="json"))
    return {"id": profile_id}


@router.post("/{profile_id}/clone", status_code=201)
@secured(requires=["permission:admin"], db_access="write")
async def clone_profile(
    profile_id: UUID, body: CloneIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    src = await _load_editable(conn, acc, profile_id)
    payload = {k: v for k, v in src.items() if k in ProfileIn.model_fields}
    payload.update(company_id=body.company_id, name=body.name, status="draft")
    new_id = await _insert(conn, acc, ProfileIn.model_validate(payload), body.company_id)
    return {"id": new_id}


@router.post("/{profile_id}/status")
@secured(requires=["permission:admin"], db_access="write")
async def set_status(
    profile_id: UUID, body: StatusIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    company, current = await _company_of(conn, profile_id)
    acc.ensure_manage(company)
    await conn.execute(
        "UPDATE vm_profiles SET status = $2, updated_by = $3, updated_at = now() WHERE id = $1",
        profile_id, body.status, acc.user_id,
    )
    action = {"archived": "archive", "active": "restore" if current == "archived" else "update"}.get(
        body.status, "update")
    await audit(conn, acc, entity_type="vm_profile", entity_id=profile_id, action=action,
                company_id=company, summary=f"status {current} -> {body.status}")
    return {"id": profile_id, "status": body.status}


@router.delete("/{profile_id}", status_code=204)
@secured(requires=["permission:admin"], db_access="write")
async def delete_profile(
    profile_id: UUID, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> None:
    company, _ = await _company_of(conn, profile_id)
    acc.ensure_manage(company)
    if await conn.fetchval("SELECT 1 FROM vm_requests WHERE vm_profile_id = $1 LIMIT 1", profile_id):
        raise Conflict("this profile has requests; archive it instead of deleting")
    await conn.execute("DELETE FROM vm_profiles WHERE id = $1", profile_id)
    await audit(conn, acc, entity_type="vm_profile", entity_id=profile_id, action="delete", company_id=company)
