"""Catalog + VMware infrastructure endpoints.

Simple tables go through the generic `crud.register`; the many-to-many
attachments (datastore <-> clusters, network <-> clusters, software <-> OS
compatibility) have dedicated "replace the set" endpoints below.

Table / column names interpolated into SQL here come only from the
code-defined RESOURCES specs (an allowlist), never from request input —
hence the `noqa: S608` markers. All values are bound as $n parameters.
"""

from typing import Any, Literal
from uuid import UUID

import asyncpg
from asyncpg.exceptions import ForeignKeyViolationError
from fastapi import Depends
from pydantic import BaseModel, Field, field_validator

from nttdsp.web import Conflict, Invalid, NotFound, SecuredRouter, db, secured

from access import Access, audit, get_access
from crud import Resource, owner_of_row, register
from netinfo import NetworkIpFields, dns_list

router = SecuredRouter()

Name = Field(..., min_length=1, max_length=120)


# ---------------------------------------------------------------------------
# Business catalogs
# ---------------------------------------------------------------------------

class OperatingSystemIn(BaseModel):
    family: Literal["windows", "linux"]
    name: str = Name
    version: str = Field("", max_length=40)
    vmware_guest_id: str = Field("", max_length=80)


class SoftwareIn(BaseModel):
    company_id: UUID | None = None
    name: str = Name
    version: str = Field("", max_length=40)
    vendor: str = Field("", max_length=120)
    install_method: Literal["script", "package", "ansible", "sccm", "chocolatey", "other"] = "script"
    install_ref: str = Field("", max_length=500)
    description: str = Field("", max_length=500)


class RoleIn(BaseModel):
    company_id: UUID | None = None
    name: str = Name
    description: str = Field("", max_length=500)


class SizeIn(BaseModel):
    company_id: UUID | None = None
    name: str = Name
    vcpu: int = Field(..., ge=1, le=256)
    cores_per_socket: int = Field(1, ge=1, le=128)
    ram_gb: int = Field(..., ge=1, le=12288)


# ---------------------------------------------------------------------------
# Infrastructure
# ---------------------------------------------------------------------------

class VcenterIn(BaseModel):
    company_id: UUID | None = None
    name: str = Name
    fqdn: str = Field(..., min_length=1, max_length=253)
    description: str = Field("", max_length=500)
    credential_secret_name: str = Field("", max_length=127)


class DatacenterIn(BaseModel):
    vcenter_id: UUID
    name: str = Name


class ClusterIn(BaseModel):
    datacenter_id: UUID
    name: str = Name
    cpu_total_mhz: int | None = Field(None, ge=1)
    cpu_used_mhz: int | None = Field(None, ge=0)
    memory_total_gb: int | None = Field(None, ge=1)
    memory_used_gb: int | None = Field(None, ge=0)


class ResourcePoolIn(BaseModel):
    cluster_id: UUID
    name: str = Name
    path: str = Field("", max_length=500)
    cpu_limit_mhz: int | None = Field(None, ge=1)
    cpu_used_mhz: int | None = Field(None, ge=0)
    memory_limit_gb: int | None = Field(None, ge=1)
    memory_used_gb: int | None = Field(None, ge=0)


class DatastoreIn(BaseModel):
    vcenter_id: UUID
    name: str = Name
    type: Literal["vmfs", "nfs", "vsan", "vvol"] = "vmfs"
    capacity_gb: int | None = Field(None, ge=1)
    used_gb: int | None = Field(None, ge=0)


class NetworkIn(NetworkIpFields):
    vcenter_id: UUID
    name: str = Name
    type: Literal["standard", "dvportgroup", "nsx"] = "dvportgroup"
    vlan_id: int | None = Field(None, ge=0, le=4094)
    dns_servers: list[str] = Field(default_factory=list, max_length=8)

    @field_validator("dns_servers", mode="before")
    @classmethod
    def _dns(cls, v: object) -> object:
        return dns_list(v) or []


class FolderIn(BaseModel):
    datacenter_id: UUID
    path: str = Field(..., min_length=1, max_length=500)


class TemplateIn(BaseModel):
    vcenter_id: UUID
    operating_system_id: UUID
    name: str = Name
    content_library: str = Field("", max_length=200)
    os_disk_gb: int | None = Field(None, ge=1)


async def _cluster_vcenter(conn: asyncpg.Connection, data: dict[str, Any]) -> dict[str, Any]:
    vcenter_id = await conn.fetchval("SELECT vcenter_id FROM datacenters WHERE id = $1", data["datacenter_id"])
    if vcenter_id is None:
        raise Invalid("datacenter does not exist")
    data["vcenter_id"] = vcenter_id
    return data


_CLUSTER_IDS = "ARRAY(SELECT x.cluster_id FROM {tbl} x WHERE x.{col} = t.id) AS cluster_ids"

RESOURCES = [
    Resource("/operating-systems", "operating_systems", "operating_system", OperatingSystemIn,
             ["family", "name", "version", "vmware_guest_id"], "global_only",
             order_by="t.family, t.name, t.version", has_audit_columns=True),
    Resource("/software", "software", "software", SoftwareIn,
             ["company_id", "name", "version", "vendor", "install_method", "install_ref", "description"],
             "company", immutable=["company_id"], order_by="t.name, t.version", has_audit_columns=True,
             extra_select=["ARRAY(SELECT x.operating_system_id FROM operating_systems_software x "
                           "WHERE x.software_id = t.id) AS operating_system_ids"]),
    Resource("/roles", "vm_roles", "vm_role", RoleIn, ["company_id", "name", "description"],
             "company", immutable=["company_id"], has_audit_columns=True),
    Resource("/sizes", "vm_sizes", "vm_size", SizeIn,
             ["company_id", "name", "vcpu", "cores_per_socket", "ram_gb"],
             "company", immutable=["company_id"], order_by="t.vcpu, t.ram_gb", has_audit_columns=True),
    Resource("/vcenters", "vcenters", "vcenter", VcenterIn,
             ["company_id", "name", "fqdn", "description", "credential_secret_name"],
             "company", immutable=["company_id"], has_audit_columns=True),
    Resource("/datacenters", "datacenters", "datacenter", DatacenterIn, ["vcenter_id", "name"],
             "vcenter", immutable=["vcenter_id"], filters=["vcenter_id"]),
    Resource("/clusters", "clusters", "cluster", ClusterIn,
             ["datacenter_id", "vcenter_id", "name", "cpu_total_mhz", "cpu_used_mhz", "memory_total_gb",
              "memory_used_gb"],
             "datacenter", immutable=["datacenter_id", "vcenter_id"],
             filters=["vcenter_id", "datacenter_id"], before_create=_cluster_vcenter,
             capacity_columns=["cpu_total_mhz", "cpu_used_mhz", "memory_total_gb", "memory_used_gb"],
             extra_select=["(SELECT d.name FROM datacenters d WHERE d.id = t.datacenter_id) AS datacenter_name"]),
    Resource("/resource-pools", "resource_pools", "resource_pool", ResourcePoolIn,
             ["cluster_id", "name", "path", "cpu_limit_mhz", "cpu_used_mhz", "memory_limit_gb", "memory_used_gb"],
             "cluster", immutable=["cluster_id"], filters=["cluster_id"],
             capacity_columns=["cpu_limit_mhz", "cpu_used_mhz", "memory_limit_gb", "memory_used_gb"],
             derived_filters={"vcenter_id": "(SELECT c.vcenter_id FROM clusters c WHERE c.id = t.cluster_id)"},
             extra_select=["(SELECT c.name FROM clusters c WHERE c.id = t.cluster_id) AS cluster_name",
                           "(SELECT c.vcenter_id FROM clusters c WHERE c.id = t.cluster_id) AS vcenter_id"]),
    Resource("/datastores", "datastores", "datastore", DatastoreIn,
             ["vcenter_id", "name", "type", "capacity_gb", "used_gb"], "vcenter", immutable=["vcenter_id"],
             filters=["vcenter_id"], capacity_columns=["capacity_gb", "used_gb"],
             extra_select=[_CLUSTER_IDS.format(tbl="clusters_datastores", col="datastore_id")]),
    Resource("/networks", "networks", "network", NetworkIn,
             ["vcenter_id", "name", "type", "vlan_id", "subnet_cidr", "gateway", "dns_servers", "dns_domain",
              "ip_pool_start", "ip_pool_end"], "vcenter", immutable=["vcenter_id"],
             filters=["vcenter_id"],
             extra_select=[_CLUSTER_IDS.format(tbl="clusters_networks", col="network_id"),
                           "CASE WHEN t.ip_pool_start IS NULL THEN NULL ELSE t.ip_pool_end - t.ip_pool_start + 1 END "
                           "AS ip_pool_size",
                           "(SELECT count(*) FROM ip_allocations a WHERE a.network_id = t.id) AS ip_allocated"]),
    Resource("/folders", "vm_folders", "vm_folder", FolderIn, ["datacenter_id", "path"],
             "datacenter", immutable=["datacenter_id"], filters=["datacenter_id"], order_by="t.path",
             derived_filters={"vcenter_id": "(SELECT d.vcenter_id FROM datacenters d WHERE d.id = t.datacenter_id)"},
             label_column="path",
             extra_select=["(SELECT d.name FROM datacenters d WHERE d.id = t.datacenter_id) AS datacenter_name",
                           "(SELECT d.vcenter_id FROM datacenters d WHERE d.id = t.datacenter_id) AS vcenter_id"]),
    Resource("/templates", "vm_templates", "vm_template", TemplateIn,
             ["vcenter_id", "operating_system_id", "name", "content_library", "os_disk_gb"],
             "vcenter", immutable=["vcenter_id"], filters=["vcenter_id", "operating_system_id"],
             extra_select=["(SELECT o.name || ' ' || o.version FROM operating_systems o "
                           "WHERE o.id = t.operating_system_id) AS operating_system_name"]),
]

for _res in RESOURCES:
    register(router, _res)


# ---------------------------------------------------------------------------
# Many-to-many "replace the set" endpoints
# ---------------------------------------------------------------------------

class ClusterIdsIn(BaseModel):
    cluster_ids: list[UUID] = Field(default_factory=list, max_length=500)


class OsIdsIn(BaseModel):
    operating_system_ids: list[UUID] = Field(default_factory=list, max_length=200)


_DATASTORES = next(r for r in RESOURCES if r.table == "datastores")
_NETWORKS = next(r for r in RESOURCES if r.table == "networks")
_SOFTWARE = next(r for r in RESOURCES if r.table == "software")


async def _replace_cluster_links(
    conn: asyncpg.Connection, acc: Access, *, res: Resource, link_table: str, link_col: str,
    item_id: UUID, cluster_ids: list[UUID],
) -> dict[str, Any]:
    _, company = await owner_of_row(conn, res, item_id)
    acc.ensure_manage(company)
    vcenter_id = await conn.fetchval(f"SELECT vcenter_id FROM {res.table} WHERE id = $1", item_id)  # noqa: S608
    wanted = set(cluster_ids)
    if wanted:
        found = await conn.fetch(
            "SELECT id FROM clusters WHERE vcenter_id = $1 AND id = ANY($2::uuid[])", vcenter_id, list(wanted)
        )
        if len(found) != len(wanted):
            raise Invalid("every cluster must belong to the same vCenter")
    current = {r["cluster_id"] for r in await conn.fetch(
        f"SELECT cluster_id FROM {link_table} WHERE {link_col} = $1", item_id)}  # noqa: S608
    removed, added = current - wanted, wanted - current
    try:
        if removed:
            await conn.execute(
                f"DELETE FROM {link_table} WHERE {link_col} = $1 AND cluster_id = ANY($2::uuid[])",  # noqa: S608
                item_id, list(removed),
            )
    except ForeignKeyViolationError as exc:
        raise Conflict("a profile still uses this item on one of the removed clusters") from exc
    if added:
        await conn.executemany(
            f"INSERT INTO {link_table} (vcenter_id, cluster_id, {link_col}) VALUES ($1, $2, $3)",  # noqa: S608
            [(vcenter_id, c, item_id) for c in added],
        )
    if added or removed:
        await audit(conn, acc, entity_type=res.entity, entity_id=item_id, action="attach",
                    company_id=company, diff={"added": list(added), "removed": list(removed)})
    return {"id": item_id, "cluster_ids": sorted(wanted, key=str)}


@router.put("/datastores/{item_id}/clusters")
@secured(requires=["permission:admin"], db_access="write")
async def set_datastore_clusters(
    item_id: UUID, body: ClusterIdsIn,
    conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access),
) -> dict[str, Any]:
    return await _replace_cluster_links(conn, acc, res=_DATASTORES, link_table="clusters_datastores",
                                        link_col="datastore_id", item_id=item_id, cluster_ids=body.cluster_ids)


@router.put("/networks/{item_id}/clusters")
@secured(requires=["permission:admin"], db_access="write")
async def set_network_clusters(
    item_id: UUID, body: ClusterIdsIn,
    conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access),
) -> dict[str, Any]:
    return await _replace_cluster_links(conn, acc, res=_NETWORKS, link_table="clusters_networks",
                                        link_col="network_id", item_id=item_id, cluster_ids=body.cluster_ids)


@router.put("/software/{item_id}/operating-systems")
@secured(requires=["permission:admin"], db_access="write")
async def set_software_os(
    item_id: UUID, body: OsIdsIn,
    conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access),
) -> dict[str, Any]:
    _, company = await owner_of_row(conn, _SOFTWARE, item_id)
    acc.ensure_manage(company)
    wanted = set(body.operating_system_ids)
    if wanted:
        n = await conn.fetchval("SELECT count(*) FROM operating_systems WHERE id = ANY($1::uuid[])", list(wanted))
        if n != len(wanted):
            raise NotFound("operating system not found")
    await conn.execute("DELETE FROM operating_systems_software WHERE software_id = $1", item_id)
    if wanted:
        await conn.executemany(
            "INSERT INTO operating_systems_software (operating_system_id, software_id) VALUES ($1, $2)",
            [(o, item_id) for o in wanted],
        )
    await audit(conn, acc, entity_type="software", entity_id=item_id, action="update",
                company_id=company, summary="OS compatibility", diff={"operating_system_ids": list(wanted)})
    return {"id": item_id, "operating_system_ids": sorted(wanted, key=str)}
