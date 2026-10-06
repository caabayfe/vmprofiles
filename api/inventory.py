"""Inventory feed API — lets external systems push vCenter infrastructure.

  PUT  /inventory/vcenter[?dry_run=true]   full snapshot of one vCenter
  GET  /inventory/vcenters                 vCenters the caller may sync (+ last sync)
  GET  /inventory/vcenters/{id}            current inventory, same shape as the PUT body
  GET  /inventory/syncs                    sync history

Callers need the `inventory_sync` role (or admin rights over the vCenter's
company). Machine callers reach the API through the portal with a token
from their own identity — see docs/inventory-api.md.
"""

import json
from collections import defaultdict
from typing import Any
from uuid import UUID

import asyncpg
from asyncpg.exceptions import CheckViolationError, ForeignKeyViolationError, UniqueViolationError
from fastapi import Depends

from nttdsp.web import Invalid, NotFound, SecuredRouter, db, secured

from access import Access, as_json, audit, get_access
from crud import db_errors
from inventory_plan import InventoryIn, build_plan, validate_snapshot

router = SecuredRouter(prefix="/inventory")

MAX_CHANGES_RETURNED = 1000


async def _ensure_company(conn: asyncpg.Connection, acc: Access, body: InventoryIn, dry_run: bool) -> UUID | None:
    ref = body.vcenter.company
    if ref is None:
        return None
    acc.ensure_sync(ref.id)
    known = await conn.fetchval("SELECT 1 FROM companies WHERE id = $1", ref.id)
    if known:
        return ref.id
    if not ref.name:
        raise Invalid("unknown company: include vcenter.company.name so it can be registered")
    if not (acc.is_global_admin or acc.sync_global):
        raise Invalid("unknown company: ask a global admin to register it first")
    if not dry_run:
        await conn.execute("INSERT INTO companies (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
                           ref.id, ref.name)
    return ref.id


@router.put("/vcenter")
@secured(requires=["permission:inventory"], db_access="write")
async def sync_vcenter(
    body: InventoryIn,
    dry_run: bool = False,
    conn: asyncpg.Connection = Depends(db),
    acc: Access = Depends(get_access),
) -> dict[str, Any]:
    """Reconcile one vCenter with the snapshot. Idempotent; all-or-nothing."""
    validate_snapshot(body)
    company_id = await _ensure_company(conn, acc, body, dry_run)
    acc.ensure_sync(company_id)

    vcenter = await conn.fetchrow(
        "SELECT id, company_id, name, fqdn, description, credential_secret_name, external_moref, is_active "
        "FROM vcenters WHERE company_id IS NOT DISTINCT FROM $1 AND lower(fqdn) = lower($2)",
        company_id, body.vcenter.fqdn,
    )
    plan = await build_plan(conn, body, dict(vcenter) if vcenter else None, company_id, acc.user_id)
    other_scope = await conn.fetchval(
        "SELECT count(*) FROM vcenters WHERE lower(fqdn) = lower($1) AND company_id IS DISTINCT FROM $2",
        body.vcenter.fqdn, company_id,
    )
    if other_scope:
        plan.warnings.append("a vCenter with this FQDN also exists under a different scope; it was not touched")

    if not dry_run:
        try:
            for sql, args in plan.ops:
                await conn.execute(sql, *args)
        except (UniqueViolationError, ForeignKeyViolationError, CheckViolationError) as exc:
            raise db_errors(exc) from exc

    persisted_vcenter = plan.vcenter_id if (vcenter or not dry_run) else None
    summary = plan.summary()
    sync_id = await conn.fetchval(
        "INSERT INTO inventory_syncs (vcenter_id, vcenter_fqdn, source, dry_run, prune, summary, warnings, "
        "change_count, user_id, user_name, real_user_id) "
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11) RETURNING id",
        persisted_vcenter, body.vcenter.fqdn, body.source, dry_run, body.prune, json.dumps(summary),
        json.dumps(plan.warnings), len(plan.changes), acc.user_id, acc.user_name, acc.real_user_id,
    )
    if not dry_run and plan.changes:
        await audit(conn, acc, entity_type="vcenter", entity_id=plan.vcenter_id, action="sync", company_id=company_id,
                    summary=f"inventory sync from {body.source or 'external system'}: {len(plan.changes)} change(s)",
                    diff={"sync_id": str(sync_id), "summary": summary})
    return {
        "sync_id": sync_id,
        "vcenter_id": persisted_vcenter,
        "dry_run": dry_run,
        "summary": summary,
        "change_count": len(plan.changes),
        "changes": plan.changes[:MAX_CHANGES_RETURNED],
        "changes_truncated": len(plan.changes) > MAX_CHANGES_RETURNED,
        "warnings": plan.warnings,
    }


@router.get("/vcenters")
@secured(requires=["permission:inventory"], db_access="read")
async def list_syncable_vcenters(
    conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        "SELECT v.id, v.name, v.fqdn, v.company_id, co.name AS company_name, v.is_active, "
        "(SELECT max(s.created_at) FROM inventory_syncs s WHERE s.vcenter_id = v.id AND NOT s.dry_run) AS last_synced_at "
        "FROM vcenters v LEFT JOIN companies co ON co.id = v.company_id ORDER BY v.name"
    )
    return [dict(r) for r in rows if acc.can_sync(r["company_id"])]


async def _vcenter_company(conn: asyncpg.Connection, vcenter_id: UUID) -> UUID | None:
    row = await conn.fetchrow("SELECT company_id FROM vcenters WHERE id = $1", vcenter_id)
    if row is None:
        raise NotFound("vCenter not found")
    return row["company_id"]


@router.get("/vcenters/{vcenter_id}")
@secured(requires=["permission:inventory", "permission:member"], db_access="read")
async def export_vcenter(
    vcenter_id: UUID, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    """Active inventory in the PUT body shape — fetch, edit, send back."""
    company_id = await _vcenter_company(conn, vcenter_id)
    if not (acc.can_sync(company_id) or acc.can_view(company_id)):
        acc.ensure_sync(company_id)
    v = await conn.fetchrow(
        "SELECT v.fqdn, v.name, v.description, v.credential_secret_name, v.external_moref, v.company_id, "
        "co.name AS company_name FROM vcenters v LEFT JOIN companies co ON co.id = v.company_id WHERE v.id = $1",
        vcenter_id)
    dcs = await conn.fetch("SELECT id, name, external_moref FROM datacenters WHERE vcenter_id = $1 AND is_active "
                           "ORDER BY name", vcenter_id)
    clusters = await conn.fetch("SELECT id, datacenter_id, name, external_moref FROM clusters "
                                "WHERE vcenter_id = $1 AND is_active ORDER BY name", vcenter_id)
    pools = await conn.fetch("SELECT p.cluster_id, p.name, p.path, p.external_moref FROM resource_pools p "
                             "JOIN clusters c ON c.id = p.cluster_id WHERE c.vcenter_id = $1 AND p.is_active "
                             "ORDER BY p.name", vcenter_id)
    folders = await conn.fetch("SELECT f.datacenter_id, f.path, f.external_moref FROM vm_folders f "
                               "JOIN datacenters d ON d.id = f.datacenter_id WHERE d.vcenter_id = $1 AND f.is_active "
                               "ORDER BY f.path", vcenter_id)
    datastores = await conn.fetch("SELECT id, name, type, capacity_gb, external_moref FROM datastores "
                                  "WHERE vcenter_id = $1 AND is_active ORDER BY name", vcenter_id)
    networks = await conn.fetch("SELECT id, name, type, vlan_id, external_moref FROM networks "
                                "WHERE vcenter_id = $1 AND is_active ORDER BY name", vcenter_id)
    templates = await conn.fetch(
        "SELECT t.name, t.operating_system_id, o.vmware_guest_id, t.os_disk_gb, t.content_library, t.external_moref "
        "FROM vm_templates t JOIN operating_systems o ON o.id = t.operating_system_id "
        "WHERE t.vcenter_id = $1 AND t.is_active ORDER BY t.name", vcenter_id)
    ds_links = await conn.fetch("SELECT l.cluster_id, d.name FROM clusters_datastores l "
                                "JOIN datastores d ON d.id = l.datastore_id WHERE l.vcenter_id = $1 AND d.is_active",
                                vcenter_id)
    net_links = await conn.fetch("SELECT l.cluster_id, n.name FROM clusters_networks l "
                                 "JOIN networks n ON n.id = l.network_id WHERE l.vcenter_id = $1 AND n.is_active",
                                 vcenter_id)

    def group(rows: list[asyncpg.Record], key: str) -> dict[UUID, list[asyncpg.Record]]:
        out: dict[UUID, list[asyncpg.Record]] = defaultdict(list)
        for r in rows:
            out[r[key]].append(r)
        return out

    pools_by, folders_by, clusters_by = group(pools, "cluster_id"), group(folders, "datacenter_id"), group(clusters, "datacenter_id")
    ds_by, net_by = group(ds_links, "cluster_id"), group(net_links, "cluster_id")
    return {
        "source": "export",
        "prune": True,
        "vcenter": {
            "fqdn": v["fqdn"], "name": v["name"], "description": v["description"],
            "credential_secret_name": v["credential_secret_name"], "moref": v["external_moref"],
            "company": {"id": v["company_id"], "name": v["company_name"]} if v["company_id"] else None,
        },
        "datacenters": [{
            "name": d["name"], "moref": d["external_moref"],
            "folders": [{"path": f["path"], "moref": f["external_moref"]} for f in folders_by[d["id"]]],
            "clusters": [{
                "name": c["name"], "moref": c["external_moref"],
                "resource_pools": [{"name": p["name"], "path": p["path"], "moref": p["external_moref"]}
                                   for p in pools_by[c["id"]]],
                "datastores": sorted(r["name"] for r in ds_by[c["id"]]),
                "networks": sorted(r["name"] for r in net_by[c["id"]]),
            } for c in clusters_by[d["id"]]],
        } for d in dcs],
        "datastores": [{"name": d["name"], "type": d["type"], "capacity_gb": d["capacity_gb"],
                        "moref": d["external_moref"]} for d in datastores],
        "networks": [{"name": n["name"], "type": n["type"], "vlan_id": n["vlan_id"], "moref": n["external_moref"]}
                     for n in networks],
        "templates": [{"name": t["name"], "operating_system_id": t["operating_system_id"],
                       "guest_id": t["vmware_guest_id"] or None, "os_disk_gb": t["os_disk_gb"],
                       "content_library": t["content_library"], "moref": t["external_moref"]} for t in templates],
    }


@router.get("/syncs")
@secured(requires=["permission:inventory", "permission:member"], db_access="read")
async def list_syncs(
    vcenter_id: UUID | None = None,
    limit: int = 50,
    conn: asyncpg.Connection = Depends(db),
    acc: Access = Depends(get_access),
) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        "SELECT s.id, s.vcenter_id, s.vcenter_fqdn, v.company_id, s.source, s.dry_run, s.prune, s.summary, "
        "s.warnings, s.change_count, s.user_name, s.created_at "
        "FROM inventory_syncs s LEFT JOIN vcenters v ON v.id = s.vcenter_id "
        "WHERE ($1::uuid IS NULL OR s.vcenter_id = $1) ORDER BY s.created_at DESC LIMIT $2",
        vcenter_id, max(1, min(limit, 500)),
    )
    return [{**dict(r), "summary": as_json(r["summary"]), "warnings": as_json(r["warnings"])}
            for r in rows if acc.can_sync(r["company_id"]) or acc.can_manage(r["company_id"])]
