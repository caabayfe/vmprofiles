"""VM provisioning requests.

On submit the profile's expanded spec (plus the requester's allowed
adjustments) is frozen into `vm_requests.spec`, so later profile edits never
change a request. v1 stops at approve / reject; a future container job can
pick up `approved` requests and drive provisioning from `spec`.
"""

import json
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import Depends
from pydantic import BaseModel, Field

from nttdsp.web import Conflict, Forbidden, Invalid, NotFound, SecuredRouter, db, secured

from access import Access, as_json, audit, get_access
from profiles import expand_profile

router = SecuredRouter(prefix="/requests")

HOSTNAME = r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"


class RequestIn(BaseModel):
    company_id: UUID
    vm_profile_id: UUID
    hostname: str = Field(..., pattern=HOSTNAME)
    quantity: int = Field(1, ge=1, le=50)
    justification: str = Field("", max_length=2000)
    excluded_software_ids: list[UUID] = Field(default_factory=list, max_length=200)


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
    out["events"] = [dict(r) for r in await conn.fetch(
        "SELECT from_status, to_status, user_name, comment, created_at FROM vm_request_events "
        "WHERE vm_request_id = $1 ORDER BY created_at", request_id)]
    return out


@router.post("", status_code=201)
@secured(requires=["permission:member"], db_access="write")
async def create_request(
    body: RequestIn, conn: asyncpg.Connection = Depends(db), acc: Access = Depends(get_access)
) -> dict[str, Any]:
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
    excluded = set(body.excluded_software_ids)
    for sw in spec["software"]:
        if sw["id"] in excluded and sw["is_mandatory"]:
            raise Invalid(f"{sw['name']} is mandatory for this profile")
    spec["software"] = [s for s in spec["software"] if s["id"] not in excluded]
    spec["request"] = {"hostname": body.hostname, "quantity": body.quantity}

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
    row = await conn.fetchrow("SELECT company_id, status FROM vm_requests WHERE id = $1 FOR UPDATE", request_id)
    if row is None:
        raise NotFound("request not found")
    if not acc.can_approve(row["company_id"]):
        raise Forbidden("only an admin of this company can decide")
    if row["status"] != "submitted":
        raise Conflict(f"request is already {row['status']}")
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
