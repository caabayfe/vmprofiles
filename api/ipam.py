"""IP address management for networks with a static pool.

IPs are assigned when a request is approved: every VM of the request gets
the lowest free address of each static network it is attached to. Admins
can also reserve addresses used outside this app, and release allocations.
Allocation locks the network row so concurrent approvals cannot hand out
the same address (the (network_id, ip) unique key is the backstop).
"""

from ipaddress import IPv4Address
from typing import Any
from uuid import UUID

import asyncpg
from asyncpg.exceptions import UniqueViolationError
from fastapi import Depends
from pydantic import BaseModel, Field

from nttdsp.web import Conflict, Invalid, NotFound, SecuredRouter, db, secured

from access import Access, audit, get_access

router = SecuredRouter()


def instance_hostnames(hostname: str, quantity: int) -> list[str]:
    """`web` x1 -> web; `web` x3 -> web01, web02, web03."""
    if quantity == 1:
        return [hostname]
    width = max(2, len(str(quantity)))
    return [f"{hostname}{i:0{width}d}" for i in range(1, quantity + 1)]


async def allocate_for_request(
    conn: asyncpg.Connection, *, request_id: UUID, spec: dict[str, Any], quantity: int, hostname: str,
    actor_id: UUID,
) -> list[dict[str, Any]]:
    """Reserve IPs for every VM of the request; returns the per-VM layout."""
    names = instance_hostnames(hostname, quantity)
    instances: list[dict[str, Any]] = [{"hostname": n, "nics": []} for n in names]
    for nic in spec["nics"]:
        net = nic["network"]
        static = net.get("addressing") == "static"
        ips: list[IPv4Address | None] = [None] * quantity
        if static:
            row = await conn.fetchrow(
                "SELECT id, name, ip_pool_start, ip_pool_end, subnet_cidr FROM networks WHERE id = $1 FOR UPDATE",
                UUID(str(net["id"])))
            if row is None or row["ip_pool_start"] is None:
                raise Conflict(f"network {net['name']} no longer has an IP pool; update the profile or the network")
            taken = {r["ip"] for r in await conn.fetch(
                "SELECT ip FROM ip_allocations WHERE network_id = $1", row["id"])}
            start, end = int(row["ip_pool_start"]), int(row["ip_pool_end"])
            free: list[IPv4Address] = []
            for n in range(start, end + 1):
                ip = IPv4Address(n)
                if ip not in taken:
                    free.append(ip)
                    if len(free) == quantity:
                        break
            if len(free) < quantity:
                raise Conflict(f"network {row['name']} has {len(free)} free IP(s) in its pool, "
                               f"{quantity} needed; extend the pool or release addresses")
            try:
                await conn.executemany(
                    "INSERT INTO ip_allocations (network_id, ip, kind, vm_request_id, hostname, nic_order, created_by) "
                    "VALUES ($1, $2, 'request', $3, $4, $5, $6)",
                    [(row["id"], ip, request_id, names[i], nic["nic_order"], actor_id) for i, ip in enumerate(free)],
                )
            except UniqueViolationError as exc:
                raise Conflict("an IP was taken concurrently; retry the approval") from exc
            ips = list(free)
            prefix = row["subnet_cidr"].prefixlen
        for i, inst in enumerate(instances):
            inst["nics"].append({
                "nic_order": nic["nic_order"], "network_id": net["id"], "network_name": net["name"],
                "addressing": net.get("addressing", "dhcp"),
                "ip": str(ips[i]) if ips[i] else None,
                "prefix_length": prefix if static else None,
                "gateway": net.get("gateway"), "dns_servers": net.get("dns_servers", []),
                "dns_domain": net.get("dns_domain", ""),
            })
    return instances


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

class ReserveIn(BaseModel):
    ip: IPv4Address
    note: str = Field("", max_length=300)


async def _network(conn: asyncpg.Connection, network_id: UUID) -> asyncpg.Record:
    row = await conn.fetchrow(
        "SELECT n.id, n.name, n.subnet_cidr, n.ip_pool_start, n.ip_pool_end, v.company_id "
        "FROM networks n JOIN vcenters v ON v.id = n.vcenter_id WHERE n.id = $1", network_id)
    if row is None:
        raise NotFound("network not found")
    return row


@router.get("/networks/{network_id}/ip-allocations")
@secured(requires=["permission:admin"], db_access="read")
async def list_allocations(
    network_id: UUID, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> list[dict[str, Any]]:
    net = await _network(conn, network_id)
    acc.ensure_manage(net["company_id"])
    rows = await conn.fetch(
        "SELECT a.id, host(a.ip) AS ip, a.kind, a.hostname, a.nic_order, a.note, a.vm_request_id, "
        "q.status AS request_status, a.created_at FROM ip_allocations a "
        "LEFT JOIN vm_requests q ON q.id = a.vm_request_id WHERE a.network_id = $1 ORDER BY a.ip", network_id)
    return [dict(r) for r in rows]


@router.post("/networks/{network_id}/ip-allocations", status_code=201)
@secured(requires=["permission:admin"], db_access="write")
async def reserve_ip(
    network_id: UUID, body: ReserveIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    """Block an address used outside this app (e.g. an existing server)."""
    net = await _network(conn, network_id)
    acc.ensure_manage(net["company_id"])
    if net["subnet_cidr"] is None or body.ip not in net["subnet_cidr"]:
        raise Invalid("the address is not inside the network's subnet")
    try:
        new_id = await conn.fetchval(
            "INSERT INTO ip_allocations (network_id, ip, kind, note, created_by) VALUES ($1, $2, 'reserved', $3, $4) "
            "RETURNING id", network_id, body.ip, body.note, acc.user_id)
    except UniqueViolationError as exc:
        raise Conflict(f"{body.ip} is already allocated") from exc
    await audit(conn, acc, entity_type="network", entity_id=network_id, action="update", company_id=net["company_id"],
                summary=f"reserved {body.ip} on {net['name']}", diff={"ip": str(body.ip), "note": body.note})
    return {"id": new_id}


@router.delete("/ip-allocations/{allocation_id}", status_code=204)
@secured(requires=["permission:admin"], db_access="write")
async def release_ip(
    allocation_id: UUID, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> None:
    row = await conn.fetchrow(
        "SELECT a.network_id, host(a.ip) AS ip, a.hostname, n.name AS network_name, v.company_id "
        "FROM ip_allocations a JOIN networks n ON n.id = a.network_id JOIN vcenters v ON v.id = n.vcenter_id "
        "WHERE a.id = $1", allocation_id)
    if row is None:
        raise NotFound("allocation not found")
    acc.ensure_manage(row["company_id"])
    await conn.execute("DELETE FROM ip_allocations WHERE id = $1", allocation_id)
    await audit(conn, acc, entity_type="network", entity_id=row["network_id"], action="update",
                company_id=row["company_id"],
                summary=f"released {row['ip']} ({row['hostname'] or 'reserved'}) on {row['network_name']}")
