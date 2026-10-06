"""One-shot lookup payload for the profile wizard.

Returns every *active* catalog item usable by a profile in a given scope
(global, or global + one company), with the vCenter hierarchy pre-nested so
the SPA can drive its cascading pickers without extra round trips.
"""

from collections import defaultdict
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import Depends

from nttdsp.web import SecuredRouter, db, secured

from access import Access, get_access

router = SecuredRouter()


@router.get("/lookups")
@secured(requires=["permission:member"], db_access="read")
async def lookups(
    company_id: UUID | None = None,
    conn: asyncpg.Connection = Depends(db),
    acc: Access = Depends(get_access),
) -> dict[str, Any]:
    acc.ensure_view(company_id)
    # Items usable by a profile in this scope: global, plus the company's own.
    scoped = "(company_id IS NULL OR company_id = $1)" if company_id else "company_id IS NULL"
    args = [company_id] if company_id else []

    roles = await conn.fetch(
        f"SELECT id, name, company_id FROM vm_roles WHERE is_active AND {scoped} ORDER BY name", *args)
    sizes = await conn.fetch(
        f"SELECT id, name, vcpu, cores_per_socket, ram_gb, company_id FROM vm_sizes "
        f"WHERE is_active AND {scoped} ORDER BY vcpu, ram_gb", *args)
    oses = await conn.fetch(
        "SELECT id, family, name, version, vmware_guest_id FROM operating_systems WHERE is_active "
        "ORDER BY family, name, version")
    software = await conn.fetch(
        f"SELECT s.id, s.name, s.version, s.vendor, s.install_method, s.company_id, "
        f"ARRAY(SELECT x.operating_system_id FROM operating_systems_software x WHERE x.software_id = s.id) "
        f"AS operating_system_ids FROM software s WHERE s.is_active AND {scoped.replace('company_id', 's.company_id')} "
        f"ORDER BY s.name, s.version", *args)
    vcenters = await conn.fetch(
        f"SELECT id, name, fqdn, company_id FROM vcenters WHERE is_active AND {scoped} ORDER BY name", *args)

    vc_ids = [v["id"] for v in vcenters]
    dcs = await conn.fetch(
        "SELECT id, vcenter_id, name FROM datacenters WHERE is_active AND vcenter_id = ANY($1::uuid[]) "
        "ORDER BY name", vc_ids)
    clusters = await conn.fetch(
        "SELECT id, vcenter_id, datacenter_id, name FROM clusters WHERE is_active AND vcenter_id = ANY($1::uuid[]) "
        "ORDER BY name", vc_ids)
    cl_ids = [c["id"] for c in clusters]
    pools = await conn.fetch(
        "SELECT id, cluster_id, name, path FROM resource_pools WHERE is_active AND cluster_id = ANY($1::uuid[]) "
        "ORDER BY name", cl_ids)
    folders = await conn.fetch(
        "SELECT f.id, f.datacenter_id, f.path FROM vm_folders f JOIN datacenters d ON d.id = f.datacenter_id "
        "WHERE f.is_active AND d.vcenter_id = ANY($1::uuid[]) ORDER BY f.path", vc_ids)
    datastores = await conn.fetch(
        "SELECT id, vcenter_id, name, type, capacity_gb FROM datastores WHERE is_active "
        "AND vcenter_id = ANY($1::uuid[]) ORDER BY name", vc_ids)
    networks = await conn.fetch(
        "SELECT id, vcenter_id, name, type, vlan_id FROM networks WHERE is_active "
        "AND vcenter_id = ANY($1::uuid[]) ORDER BY name", vc_ids)
    templates = await conn.fetch(
        "SELECT id, vcenter_id, operating_system_id, name, os_disk_gb FROM vm_templates WHERE is_active "
        "AND vcenter_id = ANY($1::uuid[]) ORDER BY name", vc_ids)
    ds_links = await conn.fetch(
        "SELECT cluster_id, datastore_id FROM clusters_datastores WHERE cluster_id = ANY($1::uuid[])", cl_ids)
    net_links = await conn.fetch(
        "SELECT cluster_id, network_id FROM clusters_networks WHERE cluster_id = ANY($1::uuid[])", cl_ids)

    pools_by = defaultdict(list)
    for p in pools:
        pools_by[p["cluster_id"]].append(dict(p))
    ds_by = defaultdict(list)
    for link in ds_links:
        ds_by[link["cluster_id"]].append(link["datastore_id"])
    net_by = defaultdict(list)
    for link in net_links:
        net_by[link["cluster_id"]].append(link["network_id"])
    clusters_by = defaultdict(list)
    for c in clusters:
        clusters_by[c["datacenter_id"]].append({
            **dict(c), "resource_pools": pools_by[c["id"]],
            "datastore_ids": ds_by[c["id"]], "network_ids": net_by[c["id"]],
        })
    folders_by = defaultdict(list)
    for f in folders:
        folders_by[f["datacenter_id"]].append(dict(f))
    dcs_by = defaultdict(list)
    for d in dcs:
        dcs_by[d["vcenter_id"]].append({**dict(d), "clusters": clusters_by[d["id"]], "folders": folders_by[d["id"]]})

    def group(rows: list[asyncpg.Record]) -> dict[UUID, list[dict[str, Any]]]:
        out: dict[UUID, list[dict[str, Any]]] = defaultdict(list)
        for r in rows:
            out[r["vcenter_id"]].append(dict(r))
        return out

    ds_g, net_g, tpl_g = group(datastores), group(networks), group(templates)
    return {
        "company_id": company_id,
        "roles": [dict(r) for r in roles],
        "sizes": [dict(r) for r in sizes],
        "operating_systems": [dict(r) for r in oses],
        "software": [dict(r) for r in software],
        "vcenters": [{
            **dict(v), "datacenters": dcs_by[v["id"]], "datastores": ds_g[v["id"]],
            "networks": net_g[v["id"]], "templates": tpl_g[v["id"]],
        } for v in vcenters],
    }
