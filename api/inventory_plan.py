"""Inventory snapshot models + reconciliation planner.

An external system sends a full snapshot of one vCenter. The planner reads
the current state, matches incoming items to existing rows and produces an
ordered list of SQL operations (plus a human-readable change list). A dry run
returns the plan; a real run executes it in the request's transaction.

Matching, per level and within the same parent:
  1. by VMware managed-object id (`moref`) when the item carries one
  2. otherwise by name (folders: by path)
A matched row is updated / restored; an unmatched incoming item is created;
an existing row missing from the snapshot is archived when `prune` is on.
Rows are never deleted — profiles may reference them. Items do not move
between parents: a cluster that moved datacenter is archived under the old
one and created under the new one.

New rows get their UUID here (not from the database) so later operations in
the same plan can reference them, and so a dry run can describe them.
"""

from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID, uuid4

import asyncpg
from pydantic import BaseModel, Field, field_validator

from nttdsp.web import Invalid

from netinfo import NetworkIpFields, dns_list

Name = Field(..., min_length=1, max_length=200)
Moref = Field(None, max_length=100)


# ---------------------------------------------------------------------------
# Snapshot payload
# ---------------------------------------------------------------------------

class PoolInv(BaseModel):
    name: str = Name
    moref: str | None = Moref
    path: str = Field("", max_length=500)


class ClusterInv(BaseModel):
    name: str = Name
    moref: str | None = Moref
    cpu_cores: int | None = Field(None, ge=1, description="Physical cores in the cluster")
    memory_total_gb: int | None = Field(None, ge=1)
    memory_free_gb: int | None = Field(None, ge=0)
    resource_pools: list[PoolInv] = Field(default_factory=list, max_length=500)
    datastores: list[str] = Field(default_factory=list, max_length=2000,
                                  description="Names or morefs of datastores (declared below) attached to this cluster")
    networks: list[str] = Field(default_factory=list, max_length=2000,
                                description="Names or morefs of networks (declared below) attached to this cluster")


class FolderInv(BaseModel):
    path: str = Field(..., min_length=1, max_length=500)
    moref: str | None = Moref


class DatacenterInv(BaseModel):
    name: str = Name
    moref: str | None = Moref
    clusters: list[ClusterInv] = Field(default_factory=list, max_length=500)
    folders: list[FolderInv] = Field(default_factory=list, max_length=2000)


class DatastoreInv(BaseModel):
    name: str = Name
    moref: str | None = Moref
    type: Literal["vmfs", "nfs", "vsan", "vvol"] = "vmfs"
    capacity_gb: int | None = Field(None, ge=1)
    free_gb: int | None = Field(None, ge=0)


class NetworkInv(NetworkIpFields):
    name: str = Name
    moref: str | None = Moref
    type: Literal["standard", "dvportgroup", "nsx"] = "dvportgroup"
    vlan_id: int | None = Field(None, ge=0, le=4094)
    # None = "not known by the feed": keeps whatever an admin set in the UI.
    dns_servers: list[str] | None = Field(None, max_length=8)
    dns_domain: str | None = Field(None, max_length=253)

    @field_validator("dns_servers", mode="before")
    @classmethod
    def _dns(cls, v: object) -> object:
        return dns_list(v)


class TemplateInv(BaseModel):
    name: str = Name
    moref: str | None = Moref
    operating_system_id: UUID | None = None
    guest_id: str | None = Field(None, max_length=80, description="VMware guestId, matched to operating_systems.vmware_guest_id")
    os_disk_gb: int | None = Field(None, ge=1)
    content_library: str = Field("", max_length=200)


class CompanyRefInv(BaseModel):
    id: UUID
    name: str | None = Field(None, max_length=200, description="Cached display name; required if the company is new to the app")


class VcenterInv(BaseModel):
    fqdn: str = Field(..., min_length=1, max_length=253)
    name: str = Name
    company: CompanyRefInv | None = Field(None, description="Owning company; omit for a generic vCenter")
    description: str = Field("", max_length=500)
    credential_secret_name: str = Field("", max_length=127)
    moref: str | None = Moref


class InventoryIn(BaseModel):
    source: str = Field("", max_length=120, description="Free-text name of the feeding system, kept in sync history")
    prune: bool = Field(True, description="Archive items missing from the snapshot and detach missing attachments")
    vcenter: VcenterInv
    datacenters: list[DatacenterInv] = Field(default_factory=list, max_length=200)
    datastores: list[DatastoreInv] = Field(default_factory=list, max_length=5000)
    networks: list[NetworkInv] = Field(default_factory=list, max_length=5000)
    templates: list[TemplateInv] = Field(default_factory=list, max_length=2000)


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------

@dataclass
class Plan:
    ops: list[tuple[str, tuple]] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    counts: dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    vcenter_id: UUID | None = None

    def add(self, entity: str, action: str, label: str, op: tuple[str, tuple] | None = None,
            detail: dict[str, Any] | None = None) -> None:
        if op:
            self.ops.append(op)
        self.counts[entity][action] += 1
        if action != "unchanged":
            self.changes.append({"entity": entity, "action": action, "name": label,
                                 **({"changed": detail} if detail else {})})

    def summary(self) -> dict[str, dict[str, int]]:
        return {k: dict(v) for k, v in sorted(self.counts.items())}


# Optional facts a feed may not know: a missing (None) value never erases one
# already stored (from an earlier sync or typed in by an admin).
KEEP_IF_NONE = {
    "external_moref", "capacity_gb", "free_gb", "cpu_cores", "memory_total_gb", "memory_free_gb",
    "subnet_cidr", "gateway", "dns_servers", "dns_domain", "ip_pool_start", "ip_pool_end",
}

ARCHIVE_SQL = {
    "datacenters": "UPDATE datacenters SET is_active = false WHERE id = $1",
    "clusters": "UPDATE clusters SET is_active = false WHERE id = $1",
    "resource_pools": "UPDATE resource_pools SET is_active = false WHERE id = $1",
    "vm_folders": "UPDATE vm_folders SET is_active = false WHERE id = $1",
    "datastores": "UPDATE datastores SET is_active = false WHERE id = $1",
    "networks": "UPDATE networks SET is_active = false WHERE id = $1",
    "vm_templates": "UPDATE vm_templates SET is_active = false WHERE id = $1",
}


def _match(existing: list[dict], incoming: list[Any], key: str) -> tuple[list[tuple[Any, dict | None]], list[dict]]:
    """Pair incoming items with existing rows: moref first, then key (name/path)."""
    used: set[UUID] = set()
    by_moref = {e["external_moref"]: e for e in existing if e["external_moref"]}
    paired: dict[int, dict | None] = {}
    for i, item in enumerate(incoming):
        e = by_moref.get(item.moref) if item.moref else None
        if e is not None and e["id"] not in used:
            used.add(e["id"])
            paired[i] = e
    by_key: dict[str, dict] = {}
    for e in existing:
        if e["id"] not in used:
            by_key.setdefault(e[key], e)
    for i, item in enumerate(incoming):
        if i in paired:
            continue
        e = by_key.get(getattr(item, key))
        if e is not None and e["id"] not in used:
            used.add(e["id"])
            paired[i] = e
        else:
            paired[i] = None
    return [(item, paired[i]) for i, item in enumerate(incoming)], [e for e in existing if e["id"] not in used]


def _reconcile(
    plan: Plan, *, entity: str, table: str, key: str, existing: list[dict], incoming: list[Any], prune: bool,
    desired: Callable[[Any], dict[str, Any]],
    insert: Callable[[UUID, dict[str, Any]], tuple[str, tuple]],
    update: Callable[[UUID, dict[str, Any]], tuple[str, tuple]],
) -> list[UUID]:
    """Plan create/update/restore/archive for one level. Returns ids parallel to `incoming`."""
    pairs, leftovers = _match(existing, incoming, key)
    ids: list[UUID] = []
    for item, row in pairs:
        want = desired(item)
        label = str(getattr(item, key))
        if row is None:
            new_id = uuid4()
            plan.add(entity, "created", label, insert(new_id, want))
            ids.append(new_id)
            continue
        changed = {k: v for k, v in want.items()
                   if row[k] != v and not (k in KEEP_IF_NONE and v is None)}
        merged = {k: (want[k] if k in changed else row[k]) for k in want}
        if not row["is_active"]:
            plan.add(entity, "restored", label, update(row["id"], merged), changed or None)
        elif changed:
            plan.add(entity, "updated", label, update(row["id"], merged), changed)
        else:
            plan.add(entity, "unchanged", label)
        ids.append(row["id"])
    if prune:
        for row in leftovers:
            if row["is_active"]:
                plan.add(entity, "archived", str(row[key]), (ARCHIVE_SQL[table], (row["id"],)))
    return ids


def _dupes(values: Iterable[str]) -> list[str]:
    seen: Counter = Counter(values)
    return sorted(v for v, n in seen.items() if n > 1)


def validate_snapshot(body: InventoryIn) -> None:
    problems: list[str] = []

    def check(what: str, values: Iterable[str]) -> None:
        d = _dupes(values)
        if d:
            problems.append(f"duplicate {what}: {', '.join(d[:10])}")

    check("datacenter names", (d.name for d in body.datacenters))
    check("datastore names", (d.name for d in body.datastores))
    check("network names", (n.name for n in body.networks))
    check("template names", (t.name for t in body.templates))
    ds_refs = {d.name for d in body.datastores} | {d.moref for d in body.datastores if d.moref}
    net_refs = {n.name for n in body.networks} | {n.moref for n in body.networks if n.moref}
    for dc in body.datacenters:
        check(f"cluster names in {dc.name}", (c.name for c in dc.clusters))
        check(f"folder paths in {dc.name}", (f.path for f in dc.folders))
        for c in dc.clusters:
            check(f"resource pool names in {dc.name}/{c.name}", (p.name for p in c.resource_pools))
            unknown = [r for r in c.datastores if r not in ds_refs] + [r for r in c.networks if r not in net_refs]
            if unknown:
                problems.append(f"cluster {dc.name}/{c.name} references undeclared datastores/networks: "
                                f"{', '.join(unknown[:10])}")
    if problems:
        raise Invalid("; ".join(problems[:20]))


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------

async def _rows(conn: asyncpg.Connection, sql: str, *args: Any) -> list[dict]:
    return [dict(r) for r in await conn.fetch(sql, *args)]


async def build_plan(conn: asyncpg.Connection, body: InventoryIn, vcenter: dict | None,
                     company_id: UUID | None, actor_id: UUID) -> Plan:
    """`vcenter` is the existing row (or None to create one)."""
    plan = Plan()
    v = body.vcenter
    prune = body.prune

    # -- vCenter itself ------------------------------------------------------
    if vcenter is None:
        vc_id = uuid4()
        plan.add("vcenters", "created", v.name, (
            "INSERT INTO vcenters (id, company_id, name, fqdn, description, credential_secret_name, "
            "external_moref, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            (vc_id, company_id, v.name, v.fqdn, v.description, v.credential_secret_name, v.moref, actor_id),
        ))
        existing: dict[str, list[dict]] = defaultdict(list)
        links_ds: set[tuple[UUID, UUID]] = set()
        links_net: set[tuple[UUID, UUID]] = set()
        used_ds: set[tuple[UUID, UUID]] = set()
        used_net: set[tuple[UUID, UUID]] = set()
    else:
        vc_id = vcenter["id"]
        want = {"name": v.name, "fqdn": v.fqdn, "description": v.description,
                "credential_secret_name": v.credential_secret_name, "external_moref": v.moref}
        changed = {k: val for k, val in want.items()
                   if vcenter[k] != val and not (k == "external_moref" and val is None)}
        merged = {k: (want[k] if k in changed else vcenter[k]) for k in want}
        op = ("UPDATE vcenters SET name = $2, fqdn = $3, description = $4, credential_secret_name = $5, "
              "external_moref = $6, is_active = true, updated_at = now() WHERE id = $1",
              (vc_id, merged["name"], merged["fqdn"], merged["description"], merged["credential_secret_name"],
               merged["external_moref"]))
        if not vcenter["is_active"]:
            plan.add("vcenters", "restored", v.name, op, changed or None)
        elif changed:
            plan.add("vcenters", "updated", v.name, op, changed)
        else:
            plan.add("vcenters", "unchanged", v.name)
        existing = {
            "datacenters": await _rows(conn, "SELECT id, name, external_moref, is_active FROM datacenters "
                                             "WHERE vcenter_id = $1", vc_id),
            "clusters": await _rows(conn, "SELECT id, datacenter_id, name, external_moref, cpu_cores, memory_total_gb, "
                                          "memory_free_gb, is_active FROM clusters WHERE vcenter_id = $1", vc_id),
            "resource_pools": await _rows(conn, "SELECT p.id, p.cluster_id, p.name, p.path, p.external_moref, "
                                                "p.is_active FROM resource_pools p JOIN clusters c ON c.id = p.cluster_id "
                                                "WHERE c.vcenter_id = $1", vc_id),
            "vm_folders": await _rows(conn, "SELECT f.id, f.datacenter_id, f.path, f.external_moref, f.is_active "
                                            "FROM vm_folders f JOIN datacenters d ON d.id = f.datacenter_id "
                                            "WHERE d.vcenter_id = $1", vc_id),
            "datastores": await _rows(conn, "SELECT id, name, type, capacity_gb, free_gb, external_moref, is_active "
                                            "FROM datastores WHERE vcenter_id = $1", vc_id),
            "networks": await _rows(conn, "SELECT id, name, type, vlan_id, subnet_cidr, gateway, dns_servers, dns_domain, "
                                          "ip_pool_start, ip_pool_end, external_moref, is_active "
                                          "FROM networks WHERE vcenter_id = $1", vc_id),
            "vm_templates": await _rows(conn, "SELECT id, name, operating_system_id, os_disk_gb, content_library, "
                                              "external_moref, is_active FROM vm_templates WHERE vcenter_id = $1", vc_id),
        }
        links_ds = {(r["cluster_id"], r["datastore_id"]) for r in await conn.fetch(
            "SELECT cluster_id, datastore_id FROM clusters_datastores WHERE vcenter_id = $1", vc_id)}
        links_net = {(r["cluster_id"], r["network_id"]) for r in await conn.fetch(
            "SELECT cluster_id, network_id FROM clusters_networks WHERE vcenter_id = $1", vc_id)}
        used_ds = {(r["cluster_id"], r["datastore_id"]) for r in await conn.fetch(
            "SELECT DISTINCT d.cluster_id, d.datastore_id FROM vm_profile_disks d JOIN clusters c ON c.id = d.cluster_id "
            "WHERE c.vcenter_id = $1 AND d.datastore_id IS NOT NULL", vc_id)}
        used_net = {(r["cluster_id"], r["network_id"]) for r in await conn.fetch(
            "SELECT DISTINCT n.cluster_id, n.network_id FROM vm_profile_nics n JOIN clusters c ON c.id = n.cluster_id "
            "WHERE c.vcenter_id = $1", vc_id)}
    plan.vcenter_id = vc_id

    # -- datacenters -----------------------------------------------------------
    dc_ids = _reconcile(
        plan, entity="datacenters", table="datacenters", key="name", existing=existing["datacenters"],
        incoming=body.datacenters, prune=prune,
        desired=lambda d: {"name": d.name, "external_moref": d.moref},
        insert=lambda i, w: ("INSERT INTO datacenters (id, vcenter_id, name, external_moref) VALUES ($1, $2, $3, $4)",
                             (i, vc_id, w["name"], w["external_moref"])),
        update=lambda i, w: ("UPDATE datacenters SET name = $2, external_moref = $3, is_active = true WHERE id = $1",
                             (i, w["name"], w["external_moref"])),
    )

    # -- vCenter-level storage and networks ------------------------------------
    ds_ids = _reconcile(
        plan, entity="datastores", table="datastores", key="name", existing=existing["datastores"],
        incoming=body.datastores, prune=prune,
        desired=lambda d: {"name": d.name, "type": d.type, "capacity_gb": d.capacity_gb, "free_gb": d.free_gb,
                           "external_moref": d.moref},
        insert=lambda i, w: ("INSERT INTO datastores (id, vcenter_id, name, type, capacity_gb, free_gb, external_moref) "
                             "VALUES ($1, $2, $3, $4, $5, $6, $7)",
                             (i, vc_id, w["name"], w["type"], w["capacity_gb"], w["free_gb"], w["external_moref"])),
        update=lambda i, w: ("UPDATE datastores SET name = $2, type = $3, capacity_gb = $4, free_gb = $5, "
                             "external_moref = $6, is_active = true WHERE id = $1",
                             (i, w["name"], w["type"], w["capacity_gb"], w["free_gb"], w["external_moref"])),
    )
    net_ids = _reconcile(
        plan, entity="networks", table="networks", key="name", existing=existing["networks"],
        incoming=body.networks, prune=prune,
        desired=lambda n: {"name": n.name, "type": n.type, "vlan_id": n.vlan_id, "subnet_cidr": n.subnet_cidr,
                           "gateway": n.gateway, "dns_servers": n.dns_servers, "dns_domain": n.dns_domain,
                           "ip_pool_start": n.ip_pool_start, "ip_pool_end": n.ip_pool_end, "external_moref": n.moref},
        insert=lambda i, w: ("INSERT INTO networks (id, vcenter_id, name, type, vlan_id, subnet_cidr, gateway, "
                             "dns_servers, dns_domain, ip_pool_start, ip_pool_end, external_moref) "
                             "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
                             (i, vc_id, w["name"], w["type"], w["vlan_id"], w["subnet_cidr"], w["gateway"],
                              w["dns_servers"] or [], w["dns_domain"] or "", w["ip_pool_start"], w["ip_pool_end"],
                              w["external_moref"])),
        update=lambda i, w: ("UPDATE networks SET name = $2, type = $3, vlan_id = $4, subnet_cidr = $5, gateway = $6, "
                             "dns_servers = $7, dns_domain = $8, ip_pool_start = $9, ip_pool_end = $10, "
                             "external_moref = $11, is_active = true WHERE id = $1",
                             (i, w["name"], w["type"], w["vlan_id"], w["subnet_cidr"], w["gateway"],
                              w["dns_servers"] or [], w["dns_domain"] or "", w["ip_pool_start"], w["ip_pool_end"],
                              w["external_moref"])),
    )
    ds_ref: dict[str, UUID] = {}
    for item, i in zip(body.datastores, ds_ids):
        ds_ref[item.name] = i
        if item.moref:
            ds_ref.setdefault(item.moref, i)
    net_ref: dict[str, UUID] = {}
    for item, i in zip(body.networks, net_ids):
        net_ref[item.name] = i
        if item.moref:
            net_ref.setdefault(item.moref, i)

    # -- clusters, pools, folders (per datacenter) -----------------------------
    cluster_links: list[tuple[str, UUID, ClusterInv]] = []
    capacity_clusters: list[UUID] = []
    for dc, dc_id in zip(body.datacenters, dc_ids):
        cl_ids = _reconcile(
            plan, entity="clusters", table="clusters", key="name", prune=prune,
            existing=[c for c in existing["clusters"] if c["datacenter_id"] == dc_id], incoming=dc.clusters,
            desired=lambda c: {"name": c.name, "cpu_cores": c.cpu_cores, "memory_total_gb": c.memory_total_gb,
                               "memory_free_gb": c.memory_free_gb, "external_moref": c.moref},
            insert=lambda i, w, dc_id=dc_id: (
                "INSERT INTO clusters (id, vcenter_id, datacenter_id, name, cpu_cores, memory_total_gb, memory_free_gb, "
                "external_moref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                (i, vc_id, dc_id, w["name"], w["cpu_cores"], w["memory_total_gb"], w["memory_free_gb"],
                 w["external_moref"])),
            update=lambda i, w: ("UPDATE clusters SET name = $2, cpu_cores = $3, memory_total_gb = $4, "
                                 "memory_free_gb = $5, external_moref = $6, is_active = true WHERE id = $1",
                                 (i, w["name"], w["cpu_cores"], w["memory_total_gb"], w["memory_free_gb"],
                                  w["external_moref"])),
        )
        _reconcile(
            plan, entity="folders", table="vm_folders", key="path", prune=prune,
            existing=[f for f in existing["vm_folders"] if f["datacenter_id"] == dc_id], incoming=dc.folders,
            desired=lambda f: {"path": f.path, "external_moref": f.moref},
            insert=lambda i, w, dc_id=dc_id: (
                "INSERT INTO vm_folders (id, datacenter_id, path, external_moref) VALUES ($1, $2, $3, $4)",
                (i, dc_id, w["path"], w["external_moref"])),
            update=lambda i, w: ("UPDATE vm_folders SET path = $2, external_moref = $3, is_active = true WHERE id = $1",
                                 (i, w["path"], w["external_moref"])),
        )
        for cl, cl_id in zip(dc.clusters, cl_ids):
            _reconcile(
                plan, entity="resource_pools", table="resource_pools", key="name", prune=prune,
                existing=[p for p in existing["resource_pools"] if p["cluster_id"] == cl_id], incoming=cl.resource_pools,
                desired=lambda p: {"name": p.name, "path": p.path, "external_moref": p.moref},
                insert=lambda i, w, cl_id=cl_id: (
                    "INSERT INTO resource_pools (id, cluster_id, name, path, external_moref) VALUES ($1, $2, $3, $4, $5)",
                    (i, cl_id, w["name"], w["path"], w["external_moref"])),
                update=lambda i, w: ("UPDATE resource_pools SET name = $2, path = $3, external_moref = $4, "
                                     "is_active = true WHERE id = $1", (i, w["name"], w["path"], w["external_moref"])),
            )
            cluster_links.append((f"{dc.name}/{cl.name}", cl_id, cl))
            if any(v is not None for v in (cl.cpu_cores, cl.memory_total_gb, cl.memory_free_gb)):
                capacity_clusters.append(cl_id)

    # -- cluster attachments (after clusters / datastores / networks exist) ----
    target_name = {r["id"]: r["name"] for r in existing["datastores"] + existing["networks"]}
    target_name.update({i: item.name for item, i in zip(body.datastores, ds_ids)})
    target_name.update({i: item.name for item, i in zip(body.networks, net_ids)})
    for label, cl_id, cl in cluster_links:
        for kind, refs, ref_map, current, used, ins, dele in (
            ("cluster_datastores", cl.datastores, ds_ref, links_ds, used_ds,
             "INSERT INTO clusters_datastores (vcenter_id, cluster_id, datastore_id) VALUES ($1, $2, $3)",
             "DELETE FROM clusters_datastores WHERE cluster_id = $1 AND datastore_id = $2"),
            ("cluster_networks", cl.networks, net_ref, links_net, used_net,
             "INSERT INTO clusters_networks (vcenter_id, cluster_id, network_id) VALUES ($1, $2, $3)",
             "DELETE FROM clusters_networks WHERE cluster_id = $1 AND network_id = $2"),
        ):
            names = {ref_map[r]: r for r in refs}
            want = set(names)
            have = {t for (c, t) in current if c == cl_id}
            for target in sorted(want - have, key=str):
                plan.add(kind, "attached", f"{label} → {names[target]}", (ins, (vc_id, cl_id, target)))
            if prune:
                for target in sorted(have - want, key=str):
                    tname = target_name.get(target, str(target))
                    if (cl_id, target) in used:
                        plan.warnings.append(f"kept {label} → {tname}: still used by a VM profile")
                        plan.add(kind, "kept_in_use", f"{label} → {tname}")
                    else:
                        plan.add(kind, "detached", f"{label} → {tname}", (dele, (cl_id, target)))

    # -- templates ---------------------------------------------------------------
    oses = await _rows(conn, "SELECT id, lower(vmware_guest_id) AS guest_id FROM operating_systems")
    os_ids = {o["id"] for o in oses}
    by_guest: dict[str, list[UUID]] = defaultdict(list)
    for o in oses:
        if o["guest_id"]:
            by_guest[o["guest_id"]].append(o["id"])
    existing_tpl = {t["id"]: t for t in existing["vm_templates"]}
    pairs, _ = _match(existing["vm_templates"], body.templates, "name")
    resolvable: list[TemplateInv] = []
    resolved_os: dict[int, UUID] = {}
    for item, row in pairs:
        os_id: UUID | None = None
        if item.operating_system_id:
            os_id = item.operating_system_id if item.operating_system_id in os_ids else None
        elif item.guest_id:
            matches = by_guest.get(item.guest_id.lower(), [])
            os_id = matches[0] if len(matches) == 1 else None
        if os_id is None and row is not None:
            os_id = row["operating_system_id"]  # keep what an admin set before
        if os_id is None:
            plan.warnings.append(
                f"skipped template {item.name}: operating system not found "
                f"(operating_system_id={item.operating_system_id}, guest_id={item.guest_id}); "
                "add the OS (with its VMware guest ID) in Catalog → Operating systems")
            plan.counts["templates"]["skipped"] += 1
            continue
        resolved_os[id(item)] = os_id
        resolvable.append(item)
    # Templates skipped for an unknown OS must not be archived because of it.
    skipped_names = {t.name for t in body.templates} - {t.name for t in resolvable}
    _reconcile(
        plan, entity="templates", table="vm_templates", key="name", prune=prune,
        existing=[t for t in existing_tpl.values() if t["name"] not in skipped_names], incoming=resolvable,
        desired=lambda t: {"name": t.name, "operating_system_id": resolved_os[id(t)], "os_disk_gb": t.os_disk_gb,
                           "content_library": t.content_library, "external_moref": t.moref},
        insert=lambda i, w: ("INSERT INTO vm_templates (id, vcenter_id, operating_system_id, name, content_library, "
                             "os_disk_gb, external_moref) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                             (i, vc_id, w["operating_system_id"], w["name"], w["content_library"], w["os_disk_gb"],
                              w["external_moref"])),
        update=lambda i, w: ("UPDATE vm_templates SET name = $2, operating_system_id = $3, content_library = $4, "
                             "os_disk_gb = $5, external_moref = $6, is_active = true WHERE id = $1",
                             (i, w["name"], w["operating_system_id"], w["content_library"], w["os_disk_gb"],
                              w["external_moref"])),
    )
    # Freshness of capacity figures — bookkeeping, not reported as a change.
    capacity_ds = [i for item, i in zip(body.datastores, ds_ids) if item.capacity_gb is not None or item.free_gb is not None]
    if capacity_clusters:
        plan.ops.append(("UPDATE clusters SET capacity_updated_at = now() WHERE id = ANY($1::uuid[])",
                         (capacity_clusters,)))
    if capacity_ds:
        plan.ops.append(("UPDATE datastores SET capacity_updated_at = now() WHERE id = ANY($1::uuid[])",
                         (capacity_ds,)))
    return plan
