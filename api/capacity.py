"""Capacity checks for a request spec.

Based only on capacity stored in the database (total + used, kept current by
the inventory feed or typed in by admins) — nothing queries vCenter live.
Free = total - used. Warnings only: they inform the requester and approver
rather than block. Checked at submit (stored with the request) and again when
the approver opens it, against whatever the database holds at that moment.
CPU is not checked: vCPUs are normally overcommitted.
"""

from collections import defaultdict
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import asyncpg

STALE_AFTER_DAYS = 7


def _age_note(updated_at: datetime | None) -> str:
    if updated_at is None:
        return ""
    days = (datetime.now(UTC) - updated_at).days
    return f" (data {days} days old)" if days >= STALE_AFTER_DAYS else ""


def _free(total: int | None, used: int | None) -> int | None:
    return None if total is None or used is None else total - used


async def capacity_warnings(conn: asyncpg.Connection, spec: dict[str, Any], quantity: int) -> list[str]:
    warnings: list[str] = []
    placement = spec["placement"]
    ram_need = spec["compute"]["ram_gb"] * quantity

    # -- cluster memory ----------------------------------------------------------
    cl = await conn.fetchrow(
        "SELECT name, memory_total_gb, memory_used_gb, capacity_updated_at FROM clusters WHERE id = $1",
        UUID(str(placement["cluster"]["id"])))
    if cl is not None:
        free = _free(cl["memory_total_gb"], cl["memory_used_gb"])
        if free is None:
            warnings.append(f"cluster {cl['name']}: memory usage unknown, {ram_need} GB RAM not checked")
        elif ram_need > free:
            warnings.append(f"cluster {cl['name']}: needs {ram_need} GB RAM, only {free} GB free"
                            f"{_age_note(cl['capacity_updated_at'])}")

    # -- resource pool memory limit (only when the pool has one) -------------------
    if placement.get("resource_pool"):
        rp = await conn.fetchrow(
            "SELECT name, memory_limit_gb, memory_used_gb, capacity_updated_at FROM resource_pools WHERE id = $1",
            UUID(str(placement["resource_pool"]["id"])))
        if rp is not None and rp["memory_limit_gb"] is not None:
            free = _free(rp["memory_limit_gb"], rp["memory_used_gb"])
            if free is None:
                warnings.append(f"resource pool {rp['name']}: memory usage unknown, limit not checked")
            elif ram_need > free:
                warnings.append(f"resource pool {rp['name']}: needs {ram_need} GB RAM, only {free} GB left under "
                                f"its limit{_age_note(rp['capacity_updated_at'])}")

    # -- datastores ----------------------------------------------------------------
    need: dict[UUID, int] = defaultdict(int)
    default_need = 0
    for d in spec["disks"]:
        size = d["size_gb"] * quantity
        if d.get("datastore"):
            need[UUID(str(d["datastore"]["id"]))] += size
        else:
            default_need += size
    rows = await conn.fetch(
        "SELECT d.id, d.name, d.capacity_gb, d.used_gb, d.capacity_updated_at FROM clusters_datastores l "
        "JOIN datastores d ON d.id = l.datastore_id WHERE l.cluster_id = $1 AND d.is_active",
        UUID(str(placement["cluster"]["id"])))
    by_id = {r["id"]: r for r in rows}
    for ds_id, gb in need.items():
        r = by_id.get(ds_id)
        if r is None:
            continue
        free = _free(r["capacity_gb"], r["used_gb"])
        if free is None:
            warnings.append(f"datastore {r['name']}: usage unknown, {gb} GB not checked")
        elif gb > free:
            warnings.append(f"datastore {r['name']}: needs {gb} GB, only {free} GB free"
                            f"{_age_note(r['capacity_updated_at'])}")
    known = [f for f in (_free(r["capacity_gb"], r["used_gb"]) for r in rows) if f is not None]
    if default_need and known and default_need > max(known):
        warnings.append(f"{default_need} GB on the cluster default datastore exceeds the largest free datastore "
                        f"({max(known)} GB)")

    # -- IP pools ------------------------------------------------------------------
    for nic in spec["nics"]:
        net = nic["network"]
        if net.get("addressing") != "static":
            continue
        free = await conn.fetchval(
            "SELECT (n.ip_pool_end - n.ip_pool_start + 1) - (SELECT count(*) FROM ip_allocations a "
            "WHERE a.network_id = n.id AND a.ip BETWEEN n.ip_pool_start AND n.ip_pool_end) "
            "FROM networks n WHERE n.id = $1 AND n.ip_pool_start IS NOT NULL", UUID(str(net["id"])))
        if free is not None and free < quantity:
            warnings.append(f"network {net['name']}: needs {quantity} IP(s), only {free} free in the pool")
    return warnings
