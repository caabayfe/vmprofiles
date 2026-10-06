"""Capacity checks for a request spec.

Warnings only: capacity figures come from the inventory feed (or are typed
in) and may be stale, so they inform the requester and approver rather than
block. Checked at submit (stored with the request) and again live when the
approver opens it.
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


async def capacity_warnings(conn: asyncpg.Connection, spec: dict[str, Any], quantity: int) -> list[str]:
    warnings: list[str] = []
    cluster_id = spec["placement"]["cluster"]["id"]

    # -- cluster memory ----------------------------------------------------------
    cl = await conn.fetchrow(
        "SELECT name, cpu_cores, memory_total_gb, memory_free_gb, capacity_updated_at FROM clusters WHERE id = $1",
        cluster_id)
    ram_need = spec["compute"]["ram_gb"] * quantity
    if cl is not None:
        if cl["memory_free_gb"] is None:
            warnings.append(f"cluster {cl['name']}: free memory unknown, {ram_need} GB RAM not checked")
        elif ram_need > cl["memory_free_gb"]:
            warnings.append(f"cluster {cl['name']}: needs {ram_need} GB RAM, only {cl['memory_free_gb']} GB free"
                            f"{_age_note(cl['capacity_updated_at'])}")

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
        "SELECT d.id, d.name, d.free_gb, d.capacity_updated_at FROM clusters_datastores l "
        "JOIN datastores d ON d.id = l.datastore_id WHERE l.cluster_id = $1 AND d.is_active", cluster_id)
    by_id = {r["id"]: r for r in rows}
    for ds_id, gb in need.items():
        r = by_id.get(ds_id)
        if r is None:
            continue
        if r["free_gb"] is None:
            warnings.append(f"datastore {r['name']}: free space unknown, {gb} GB not checked")
        elif gb > r["free_gb"]:
            warnings.append(f"datastore {r['name']}: needs {gb} GB, only {r['free_gb']} GB free"
                            f"{_age_note(r['capacity_updated_at'])}")
    known = [r["free_gb"] for r in rows if r["free_gb"] is not None]
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
