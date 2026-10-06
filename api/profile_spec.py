"""The fully resolved ("expanded") profile spec.

Used by GET /profiles/{id}/expanded, the request form, and frozen into
vm_requests.spec at submit time (it is also the input a future provisioning
job will consume), so it carries ids, names, VMware identifiers and network
addressing — plus `adjustable`: what a requester may change and within which
limits.
"""

from typing import Any
from uuid import UUID

import asyncpg

from nttdsp.web import NotFound


def ref(i: Any, **kw: Any) -> dict[str, Any] | None:
    return {"id": i, **kw} if i is not None else None


def _s(value: Any) -> str | None:
    return None if value is None else str(value)


# Columns of `networks w` needed to describe a NIC's network.
NETWORK_COLS = (
    "w.id AS network_id, w.name AS network_name, w.vlan_id, w.type AS network_type, w.is_active AS network_active, "
    "w.subnet_cidr, w.gateway, w.dns_servers, w.dns_domain, w.ip_pool_start, w.ip_pool_end"
)


def network_info(r: asyncpg.Record | dict) -> dict[str, Any]:
    """Network reference incl. addressing; `addressing` is 'static' when the
    network has an IP pool (IPs assigned on approval), else 'dhcp'."""
    static = r["ip_pool_start"] is not None
    return {
        "id": r["network_id"], "name": r["network_name"], "vlan_id": r["vlan_id"], "type": r["network_type"],
        "addressing": "static" if static else "dhcp",
        "subnet_cidr": _s(r["subnet_cidr"]), "gateway": _s(r["gateway"]),
        "dns_servers": list(r["dns_servers"] or []), "dns_domain": r["dns_domain"],
    }


async def expand_profile(conn: asyncpg.Connection, profile_id: UUID) -> dict[str, Any]:
    p = await conn.fetchrow(
        """
        SELECT p.id, p.name, p.description, p.status, p.company_id, co.name AS company_name,
               p.naming_pattern, p.notes, p.vcpu_override, p.ram_gb_override,
               p.max_extra_disks, p.max_extra_disk_gb,
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
        "SELECT n.nic_order, n.adapter_type, " + NETWORK_COLS + " "
        "FROM vm_profile_nics n JOIN networks w ON w.id = n.network_id "
        "WHERE n.vm_profile_id = $1 ORDER BY n.nic_order", profile_id)
    nic_options = await conn.fetch(
        "SELECT o.nic_order, " + NETWORK_COLS + " "
        "FROM vm_profile_nic_options o JOIN networks w ON w.id = o.network_id "
        "WHERE o.vm_profile_id = $1 AND w.is_active ORDER BY o.nic_order, w.name", profile_id)
    software = await conn.fetch(
        "SELECT s.id, s.name, s.version, s.vendor, s.install_method, s.install_ref, s.is_active, "
        "s.company_id IS NULL AS is_global, ps.install_order, ps.is_mandatory "
        "FROM vm_profiles_software ps JOIN software s ON s.id = ps.software_id "
        "WHERE ps.vm_profile_id = $1 ORDER BY ps.install_order, s.name", profile_id)
    sizes = await conn.fetch(
        "SELECT z.id, z.name, z.vcpu, z.cores_per_socket, z.ram_gb FROM vm_profiles_allowed_sizes a "
        "JOIN vm_sizes z ON z.id = a.vm_size_id WHERE a.vm_profile_id = $1 AND z.is_active "
        "ORDER BY z.vcpu, z.ram_gb", profile_id)
    datastores = await conn.fetch(
        "SELECT d.id, d.name, CASE WHEN d.capacity_gb IS NOT NULL AND d.used_gb IS NOT NULL "
        "THEN d.capacity_gb - d.used_gb END AS free_gb "
        "FROM clusters_datastores l JOIN datastores d ON d.id = l.datastore_id "
        "WHERE l.cluster_id = $1 AND d.is_active ORDER BY d.name", p["cluster_id"])

    warnings = [label for label, ok in [
        ("role", p["role_active"]), ("operating system", p["os_active"]), ("size", p["size_active"]),
        ("vCenter", p["vcenter_active"]), ("cluster", p["cluster_active"]),
        ("resource pool", p["pool_active"] is not False), ("template", p["template_active"] is not False),
    ] if not ok]
    warnings += [f"datastore {d['datastore_name']}" for d in disks if d["datastore_active"] is False]
    warnings += [f"network {n['network_name']}" for n in nics if not n["network_active"]]
    warnings += [f"software {s['name']}" for s in software if not s["is_active"]]

    profile_size = {"id": p["size_id"], "name": p["size_name"], "vcpu": p["vcpu_override"] or p["vcpu"],
                    "cores_per_socket": p["cores_per_socket"], "ram_gb": p["ram_gb_override"] or p["ram_gb"]}
    options_by_nic: dict[int, list[dict[str, Any]]] = {}
    for o in nic_options:
        options_by_nic.setdefault(o["nic_order"], []).append(network_info(o))

    return {
        "id": p["id"], "name": p["name"], "description": p["description"], "status": p["status"],
        "company": ref(p["company_id"], name=p["company_name"]),
        "role": ref(p["role_id"], name=p["role_name"]),
        "operating_system": ref(p["os_id"], family=p["os_family"], name=p["os_name"], version=p["os_version"],
                                vmware_guest_id=p["vmware_guest_id"]),
        "compute": {
            "size": ref(p["size_id"], name=p["size_name"]),
            "vcpu": profile_size["vcpu"],
            "cores_per_socket": p["cores_per_socket"],
            "ram_gb": profile_size["ram_gb"],
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
        "nics": [{"nic_order": n["nic_order"], "adapter_type": n["adapter_type"], "network": network_info(n)}
                 for n in nics],
        "software": [{
            "id": s["id"], "name": s["name"], "version": s["version"], "vendor": s["vendor"],
            "install_method": s["install_method"], "install_ref": s["install_ref"],
            "install_order": s["install_order"], "is_mandatory": s["is_mandatory"],
            "scope": "global" if s["is_global"] else "company",
        } for s in software],
        "naming_pattern": p["naming_pattern"],
        "notes": p["notes"],
        "warnings": warnings,
        "adjustable": {
            # The profile's own size (with any override) first, then allowed alternatives.
            "sizes": [profile_size] + [dict(z) for z in sizes if z["id"] != p["size_id"]],
            "max_extra_disks": p["max_extra_disks"],
            "max_extra_disk_gb": p["max_extra_disk_gb"],
            "datastores": [dict(d) for d in datastores],
            "nic_options": [
                {"nic_order": n["nic_order"],
                 "networks": [network_info(n)] + [o for o in options_by_nic.get(n["nic_order"], [])
                                                  if o["id"] != n["network_id"]]}
                for n in nics if options_by_nic.get(n["nic_order"])
            ],
        },
    }
