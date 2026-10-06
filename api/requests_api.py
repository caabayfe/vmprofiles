"""VM provisioning requests.

On submit the profile's expanded spec, with the requester's adjustments
applied (size, extra disks, NIC networks — only within the limits the
profile allows), is frozen into `vm_requests.spec`, so later profile edits
never change a request. Capacity warnings are stored with it. Approval
allocates static IPs (ipam.py) and records the per-VM layout in
`spec.instances`. A future container job can pick up `approved` requests and
drive provisioning from `spec`.
"""

import json
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import Depends
from pydantic import BaseModel, Field

from nttdsp.web import Conflict, Forbidden, Invalid, NotFound, SecuredRouter, db, secured

from access import Access, as_json, audit, get_access
from capacity import capacity_warnings
from ipam import allocate_for_request, instance_hostnames
from profile_spec import expand_profile

router = SecuredRouter(prefix="/requests")

HOSTNAME = r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"


class RequestIn(BaseModel):
    company_id: UUID
    vm_profile_id: UUID
    hostname: str = Field(..., pattern=HOSTNAME)
    quantity: int = Field(1, ge=1, le=50)
    justification: str = Field("", max_length=2000)
    excluded_software_ids: list[UUID] = Field(default_factory=list, max_length=200)
    # Adjustments — validated against the profile's `adjustable` limits.
    vm_size_id: UUID | None = None
    extra_disks: list["ExtraDiskIn"] = Field(default_factory=list, max_length=20)
    nic_networks: list["NicChoiceIn"] = Field(default_factory=list, max_length=10)


class ExtraDiskIn(BaseModel):
    size_gb: int = Field(..., ge=1, le=65536)
    mount_point: str = Field(..., min_length=1, max_length=200)
    label: str = Field("", max_length=80)
    datastore_id: UUID | None = None


class NicChoiceIn(BaseModel):
    nic_order: int = Field(..., ge=0, le=9)
    network_id: UUID


RequestIn.model_rebuild()


class DecisionIn(BaseModel):
    comment: str = Field("", max_length=2000)


_LIST_SQL = """
SELECT q.id, q.company_id, co.name AS company_name, q.vm_profile_id, q.spec->>'name' AS profile_name,
       q.hostname, q.quantity, q.status, q.requested_by, q.requested_by_name, q.submitted_at,
       q.decided_by_name, q.decided_at, q.created_at
FROM vm_requests q JOIN companies co ON co.id = q.company_id
"""


@router.get("")
@secured(requires=["permission:member"], db_access="read")
async def list_requests(
    view: Literal["mine", "pending", "all"] = "mine",
    company_id: UUID | None = None,
    status: str | None = None,
    conn: asyncpg.Connection = Depends(db),
    acc: Access = Depends(get_access),
) -> list[dict[str, Any]]:
    args: list[Any] = []
    where: list[str] = []
    if view == "mine":
        args.append(acc.user_id)
        where.append(f"q.requested_by = ${len(args)}")
    else:
        if not acc.is_global_admin:
            # Admins see their companies' requests; requesters only their own.
            args.append(list(acc.admin_companies))
            args.append(acc.user_id)
            where.append(f"(q.company_id = ANY(${len(args) - 1}::uuid[]) OR q.requested_by = ${len(args)})")
        if view == "pending":
            where.append("q.status = 'submitted'")
            if not acc.is_global_admin:
                args.append(list(acc.admin_companies))
                where.append(f"q.company_id = ANY(${len(args)}::uuid[])")
    if company_id is not None:
        args.append(company_id)
        where.append(f"q.company_id = ${len(args)}")
    if status:
        args.append(status)
        where.append(f"q.status = ${len(args)}")
    sql = f"{_LIST_SQL} WHERE {' AND '.join(where) or 'TRUE'} ORDER BY q.created_at DESC LIMIT 500"
    return [dict(r) for r in await conn.fetch(sql, *args)]


async def _load(conn: asyncpg.Connection, acc: Access, request_id: UUID) -> dict[str, Any]:
    row = await conn.fetchrow(
        "SELECT q.id, q.company_id, co.name AS company_name, q.vm_profile_id, q.hostname, q.quantity, "
        "q.justification, q.status, q.status_reason, q.spec, q.requested_by, q.requested_by_name, "
        "q.submitted_at, q.decided_by, q.decided_by_name, q.decided_at, q.created_at "
        "FROM vm_requests q JOIN companies co ON co.id = q.company_id WHERE q.id = $1",
        request_id,
    )
    if row is None:
        raise NotFound("request not found")
    out = dict(row)
    if out["requested_by"] != acc.user_id and not acc.can_approve(out["company_id"]):
        raise Forbidden("not visible")
    out["spec"] = as_json(out["spec"])
    out["can_decide"] = out["status"] == "submitted" and acc.can_approve(out["company_id"])
    return out


@router.get("/{request_id}")
@secured(requires=["permission:member"], db_access="read")
async def get_request(
    request_id: UUID, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    out = await _load(conn, acc, request_id)
    if out["status"] == "submitted":
        # Fresh check for the approver; the one stored at submit stays in spec.
        out["capacity_now"] = await capacity_warnings(conn, out["spec"], out["quantity"])
    out["events"] = [dict(r) for r in await conn.fetch(
        "SELECT from_status, to_status, user_name, comment, created_at FROM vm_request_events "
        "WHERE vm_request_id = $1 ORDER BY created_at", request_id)]
    return out


async def build_spec(conn: asyncpg.Connection, acc: Access, body: RequestIn) -> dict[str, Any]:
    """Expanded profile + validated requester adjustments + capacity check."""
    if not acc.can_request(body.company_id):
        raise Forbidden("you cannot request VMs for this company")
    prof = await conn.fetchrow("SELECT company_id, status FROM vm_profiles WHERE id = $1", body.vm_profile_id)
    if prof is None:
        raise NotFound("profile not found")
    if prof["status"] != "active":
        raise Invalid("only active profiles can be requested")
    if prof["company_id"] is not None and prof["company_id"] != body.company_id:
        raise Invalid("this profile belongs to a different company")

    spec = await expand_profile(conn, body.vm_profile_id)
    adj = spec.pop("adjustable")
    changes: dict[str, Any] = {}

    # Software: only optional items can be dropped.
    excluded = set(body.excluded_software_ids)
    for sw in spec["software"]:
        if sw["id"] in excluded and sw["is_mandatory"]:
            raise Invalid(f"{sw['name']} is mandatory for this profile")
    if excluded:
        changes["excluded_software"] = [s["name"] for s in spec["software"] if s["id"] in excluded]
    spec["software"] = [s for s in spec["software"] if s["id"] not in excluded]

    # Size: one of the sizes the profile allows.
    if body.vm_size_id and body.vm_size_id != spec["compute"]["size"]["id"]:
        size = next((z for z in adj["sizes"] if z["id"] == body.vm_size_id), None)
        if size is None:
            raise Invalid("this size is not allowed for the profile")
        changes["size"] = {"from": spec["compute"]["size"]["name"], "to": size["name"]}
        spec["compute"] = {"size": {"id": size["id"], "name": size["name"]}, "vcpu": size["vcpu"],
                           "cores_per_socket": size["cores_per_socket"], "ram_gb": size["ram_gb"],
                           "overridden": False}

    # Extra data disks: within count / size limits, on an attached datastore.
    if body.extra_disks:
        if len(body.extra_disks) > adj["max_extra_disks"]:
            raise Invalid(f"this profile allows at most {adj['max_extra_disks']} extra disk(s)")
        ds_by_id = {d["id"]: d for d in adj["datastores"]}
        mounts = {d["mount_point"].strip().lower() for d in spec["disks"]}
        next_order = max(d["disk_order"] for d in spec["disks"]) + 1
        for i, extra in enumerate(body.extra_disks):
            if extra.size_gb > adj["max_extra_disk_gb"]:
                raise Invalid(f"extra disks can be at most {adj['max_extra_disk_gb']} GB")
            mount = extra.mount_point.strip()
            if mount.lower() in mounts:
                raise Invalid(f"mount point {mount} is already used")
            mounts.add(mount.lower())
            if extra.datastore_id and extra.datastore_id not in ds_by_id:
                raise Invalid("an extra disk's datastore is not attached to the profile's cluster")
            ds = ds_by_id.get(extra.datastore_id) if extra.datastore_id else None
            spec["disks"].append({
                "disk_order": next_order + i, "label": extra.label or f"Extra {i + 1}", "size_gb": extra.size_gb,
                "mount_point": mount, "filesystem": "", "provisioning": "thin",
                "datastore": {"id": ds["id"], "name": ds["name"]} if ds else None, "requested": True,
            })
        spec["disk_total_gb"] = sum(d["size_gb"] for d in spec["disks"])
        changes["extra_disks"] = [{"mount_point": e.mount_point, "size_gb": e.size_gb} for e in body.extra_disks]

    # NIC networks: one of the alternatives the profile offers for that NIC.
    if body.nic_networks:
        options = {o["nic_order"]: {n["id"]: n for n in o["networks"]} for o in adj["nic_options"]}
        for choice in body.nic_networks:
            nets = options.get(choice.nic_order)
            if not nets or choice.network_id not in nets:
                raise Invalid(f"network not allowed for NIC {choice.nic_order + 1}")
            nic = next(n for n in spec["nics"] if n["nic_order"] == choice.nic_order)
            if nic["network"]["id"] != choice.network_id:
                changes.setdefault("networks", []).append(
                    {"nic_order": choice.nic_order, "from": nic["network"]["name"], "to": nets[choice.network_id]["name"]})
                nic["network"] = nets[choice.network_id]

    spec["request"] = {"hostname": body.hostname, "quantity": body.quantity,
                       "hostnames": instance_hostnames(body.hostname, body.quantity)}
    spec["adjustments"] = changes
    spec["capacity_check"] = {"checked_at": datetime.now(UTC).isoformat(),
                              "warnings": await capacity_warnings(conn, spec, body.quantity)}
    return spec


@router.post("/preview")
@secured(requires=["permission:member"], db_access="read")
async def preview_request(
    body: RequestIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    """Validate a request and return the spec it would freeze, with capacity warnings."""
    return await build_spec(conn, acc, body)


@router.post("", status_code=201)
@secured(requires=["permission:member"], db_access="write")
async def create_request(
    body: RequestIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    spec = await build_spec(conn, acc, body)
    request_id = await conn.fetchval(
        "INSERT INTO vm_requests (company_id, vm_profile_id, hostname, quantity, justification, status, spec, "
        "requested_by, requested_by_name, real_requested_by, submitted_at) "
        "VALUES ($1, $2, $3, $4, $5, 'submitted', $6::jsonb, $7, $8, $9, now()) RETURNING id",
        body.company_id, body.vm_profile_id, body.hostname, body.quantity, body.justification,
        json.dumps(spec, default=str), acc.user_id, acc.user_name, acc.real_user_id,
    )
    await conn.execute(
        "INSERT INTO vm_request_events (vm_request_id, from_status, to_status, user_id, user_name) "
        "VALUES ($1, '', 'submitted', $2, $3)", request_id, acc.user_id, acc.user_name)
    await audit(conn, acc, entity_type="vm_request", entity_id=request_id, action="submit",
                company_id=body.company_id, summary=f"{body.hostname} x{body.quantity} ({spec['name']})")
    return {"id": request_id}


async def _decide(
    conn: asyncpg.Connection, acc: Access, request_id: UUID, to_status: str, comment: str
) -> dict[str, Any]:
    row = await conn.fetchrow(
        "SELECT company_id, status, hostname, quantity, spec FROM vm_requests WHERE id = $1 FOR UPDATE", request_id)
    if row is None:
        raise NotFound("request not found")
    if not acc.can_approve(row["company_id"]):
        raise Forbidden("only an admin of this company can decide")
    if row["status"] != "submitted":
        raise Conflict(f"request is already {row['status']}")
    if to_status == "approved":
        spec = as_json(row["spec"])
        instances = await allocate_for_request(conn, request_id=request_id, spec=spec, quantity=row["quantity"],
                                               hostname=row["hostname"], actor_id=acc.user_id)
        await conn.execute("UPDATE vm_requests SET spec = spec || jsonb_build_object('instances', $2::jsonb) "
                           "WHERE id = $1", request_id, json.dumps(instances, default=str))
    await conn.execute(
        "UPDATE vm_requests SET status = $2, status_reason = $3, decided_by = $4, decided_by_name = $5, "
        "decided_at = now(), updated_at = now() WHERE id = $1",
        request_id, to_status, comment, acc.user_id, acc.user_name)
    await conn.execute(
        "INSERT INTO vm_request_events (vm_request_id, from_status, to_status, user_id, user_name, comment) "
        "VALUES ($1, 'submitted', $2, $3, $4, $5)", request_id, to_status, acc.user_id, acc.user_name, comment)
    await audit(conn, acc, entity_type="vm_request", entity_id=request_id,
                action="approve" if to_status == "approved" else "reject",
                company_id=row["company_id"], summary=comment)
    return {"id": request_id, "status": to_status}


@router.post("/{request_id}/approve")
@secured(requires=["permission:admin"], db_access="write")
async def approve_request(
    request_id: UUID, body: DecisionIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    return await _decide(conn, acc, request_id, "approved", body.comment)


@router.post("/{request_id}/reject")
@secured(requires=["permission:admin"], db_access="write")
async def reject_request(
    request_id: UUID, body: DecisionIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
    if not body.comment.strip():
        raise Invalid("a reason is required to reject")
    return await _decide(conn, acc, request_id, "rejected", body.comment)
